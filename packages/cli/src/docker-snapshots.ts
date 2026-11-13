import { type GoldenConfig, GoldenError, parseDockerSnapshotRecord, snapshotUpdateAvailable } from "@armada/core";
import { type Args, flag, single } from "./args.ts";
import { createArmadaApiClient } from "./armada-api.ts";
import type { AuthIo } from "./auth-commands.ts";
import { resolveHost } from "./host-commands.ts";
export async function dockerSnapshotCommand(
  operation: string,
  args: Args,
  io: Pick<AuthIo, "out" | "err">,
  auth: AuthIo,
  config?: GoldenConfig,
) {
  const allowed = new Set([
    "--org",
    "--provider",
    "--json",
    ...(operation === "rebuild" ? ["--request-id"] : []),
    ...(operation === "create" ? ["--host", "--request-id", "--private", "--config", "--repo", "--init"] : []),
  ]);
  if ([...args.options.keys()].some((key) => !allowed.has(key)))
    throw new GoldenError("invalid_config", "Unsupported Docker snapshot option.");
  const org = single(args, "--org");
  if (!org || !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(org))
    throw new GoldenError("invalid_config", "Docker snapshots require --org UUID.");
  const client = await createArmadaApiClient(auth);
  const post = (path: string, body: object) =>
    client.request<Record<string, unknown>>(`/api/v1/docker/snapshots/${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ org, ...body }),
    });
  if (operation === "list") {
    if (args.positionals.length) throw new GoldenError("invalid_config", "golden list takes no name.");
    const data = await post("list", {});
    if (!Array.isArray(data.snapshots)) throw Error("Invalid snapshot response.");
    const rows = data.snapshots.map(parseDockerSnapshotRecord);
    const currentVersion = typeof data.currentVersion === "string" ? data.currentVersion : null;
    io.out(
      flag(args, "--json")
        ? JSON.stringify(rows, null, 2) + "\n"
        : rows
            .map(
              (r) =>
                `${r.id}\t${r.name}\t${r.status}\t${r.visibility}\t${r.hostName ?? r.hostId}${r.failureReason ? `\t${r.failureReason}` : ""}\tBuilt on Armada ${r.builtOnVersion ?? "unknown version"}${snapshotUpdateAvailable(r.builtOnVersion, currentVersion) ? ` · Update to ${currentVersion}: armada golden rebuild ${r.id} --provider docker --org ${org}` : ""}`,
            )
            .join("\n") + "\n",
    );
    return 0;
  }
  if (operation === "rebuild") {
    const id = args.positionals[0],
      requestId = single(args, "--request-id") ?? crypto.randomUUID();
    const uuid = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
    if (args.positionals.length !== 1 || !id || !uuid.test(id) || !uuid.test(requestId) || id === requestId)
      throw new GoldenError(
        "invalid_config",
        "Use golden rebuild SNAPSHOT_UUID --provider docker [--request-id UUID].",
      );
    io.err(
      `Rebuild request ${requestId}. The old snapshot stays usable. Retry with the same --request-id after an unknown outcome.\n`,
    );
    const row = parseDockerSnapshotRecord((await post("rebuild", { id, requestId })).snapshot);
    if (row.id !== requestId)
      throw new GoldenError(
        "invalid_config",
        "Rebuild outcome unknown: the server returned a different snapshot. Inspect the printed request ID before retrying.",
      );
    io.out(
      flag(args, "--json")
        ? JSON.stringify(row, null, 2) + "\n"
        : `New Docker snapshot: ${row.id}\nBuild: ${row.status}\nBuilt on Armada: ${row.builtOnVersion ?? "unknown version"}\nOriginal snapshot unchanged: ${id}\n`,
    );
    return 0;
  }
  if (operation === "get") {
    if (args.positionals.length !== 1) throw new GoldenError("invalid_config", "golden get requires a snapshot UUID.");
    const row = parseDockerSnapshotRecord((await post("get", { id: args.positionals[0] })).snapshot);
    io.out(JSON.stringify(row, null, 2) + "\n");
    return 0;
  }
  if (operation !== "create" || args.positionals.length !== 1 || !config)
    throw new GoldenError(
      "invalid_config",
      "Use golden create NAME --provider docker --host UUID|NAME --config FILE [--private].",
    );
  const selector = single(args, "--host");
  if (!selector) throw new GoldenError("invalid_config", "Docker snapshot creation requires --host UUID|NAME.");
  const requestId = single(args, "--request-id") ?? crypto.randomUUID();
  if (!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(requestId))
    throw new GoldenError("invalid_config", "--request-id requires a UUID.");
  const hostId = await resolveHost(client, org, selector);
  io.err(`Snapshot request ${requestId}. Reuse this --request-id with identical input after an unknown outcome.\n`);
  const row = parseDockerSnapshotRecord(
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
  io.out(
    flag(args, "--json")
      ? JSON.stringify(row, null, 2) + "\n"
      : `Docker snapshot: ${row.id}\nName: ${row.name}\nBuild: ${row.status}\nBuilt on Armada: ${row.builtOnVersion ?? "unknown version"}\nRead: armada golden get ${row.id} --provider docker --org ${org}\n`,
  );
  return 0;
}
