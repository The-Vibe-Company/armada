import type { ArmadaConfig, Credentials, DigestRequest } from "@armada/core";
import { type Io, UsageError } from "./io.ts";
import { liveFleet, type WorkerArgs } from "./worker.ts";

export async function digest(
  io: Io,
  config: ArmadaConfig,
  credentials: Credentials,
  args: WorkerArgs,
): Promise<number> {
  if (args.rest.length) throw new UsageError(`unexpected argument ${args.rest[0]}`);
  if (credentials.armadaSignIn?.kind === "worker")
    throw new UsageError("The coordinator runs armada digest; worker sessions cannot read or send it");
  const raw = args.options.since;
  const now = (io.now ?? (() => new Date()))();
  let since: string | null = null;
  if (raw) {
    const duration = /^(\d+(?:\.\d+)?)(m|h|d)$/.exec(raw);
    const ms = duration
      ? Number(duration[1]) * ({ m: 60_000, h: 3_600_000, d: 86_400_000 }[duration[2] ?? ""] ?? 0)
      : null;
    const at =
      ms === null
        ? /^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(raw)
          ? Date.parse(raw)
          : Number.NaN
        : now.getTime() - ms;
    if (!Number.isFinite(at) || at > now.getTime() || at < 0)
      throw new UsageError("--since must be an ISO timestamp no later than now, or a duration such as 4h");
    since = new Date(at).toISOString();
  }
  const language = args.options.lang ?? (config.tracker.language?.toLowerCase().startsWith("fr") ? "fr" : "en");
  if (language !== "en" && language !== "fr") throw new UsageError("--lang must be en or fr");
  const { fleet } = liveFleet(io, config, credentials);
  if (!fleet) throw new UsageError("armada digest needs a sign-in to Armada", "armada login");
  const input: DigestRequest = { since, language };
  const result = await (args.options.send === "true" ? fleet.sendDigest(input) : fleet.digest(input));
  io.stdout(args.json ? `${JSON.stringify(result, null, 2)}\n` : `${result.text}\n`);
  return 0;
}
