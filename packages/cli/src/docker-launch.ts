import {
  type DockerLaunchRequest,
  type DockerLaunchResult,
  GoldenError,
  HARNESSES,
  type Harness,
  resolveModelChoice,
} from "@armada/core";
import { type Args, single } from "./args.ts";
import { createArmadaApiClient } from "./armada-api.ts";
import type { AuthIo } from "./auth-commands.ts";
import { parseTtl } from "./operations.ts";

const uuid = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
/** API-only plain-image launch. No golden, provider credential or database dependency. */
export async function launchDocker(args: Args, io: Pick<AuthIo, "out" | "err">, auth: AuthIo): Promise<number> {
  const allowed = new Set([
    "--provider",
    "--host",
    "--image",
    "--credential-id",
    "--credential-version",
    "--request-id",
    "--agent",
    "--org",
    "--model",
    "--reasoning-effort",
    "--ttl",
    "--json",
  ]);
  if ([...args.options.keys()].some((key) => !allowed.has(key)) || args.positionals.length > 1)
    throw new GoldenError(
      "invalid_config",
      "Docker launch takes at most one prompt and no golden, repository, size, connections or skills.",
    );
  const harness = (single(args, "--agent") ?? "codex") as Harness;
  if (!HARNESSES.includes(harness)) throw new GoldenError("invalid_config", "Unknown Docker harness.");
  const requiredId = (flag: string) => {
    const value = single(args, flag);
    if (!value || !uuid.test(value))
      throw new GoldenError("invalid_config", `${flag} requires a UUID for Docker launch.`);
    return value.toLowerCase();
  };
  const org = requiredId("--org"),
    hostId = requiredId("--host"),
    credentialId = requiredId("--credential-id");
  const image = single(args, "--image")?.trim();
  if (!image)
    throw new GoldenError("invalid_config", "Docker launch requires --image with a digest-pinned image reference.");
  const supplied = single(args, "--request-id");
  if (supplied !== undefined && !uuid.test(supplied))
    throw new GoldenError("invalid_config", "--request-id requires a UUID.");
  const requestId = supplied?.toLowerCase() ?? crypto.randomUUID();
  const version = single(args, "--credential-version");
  if (version !== undefined && (!/^[1-9][0-9]*$/.test(version) || !Number.isSafeInteger(Number(version))))
    throw new GoldenError("invalid_config", "--credential-version must be a positive integer.");
  const ttl = single(args, "--ttl");
  const body: DockerLaunchRequest = {
    org,
    provider: "docker",
    hostId,
    image,
    harness,
    credentialId,
    requestId,
    ...resolveModelChoice(harness, {
      model: single(args, "--model"),
      reasoningEffort: single(args, "--reasoning-effort"),
    }),
    ...(version === undefined ? {} : { credentialVersion: Number(version) }),
    ...(ttl === undefined ? {} : { ttlSeconds: parseTtl(ttl) }),
    ...(args.positionals[0] === undefined ? {} : { prompt: args.positionals[0] }),
  };
  const client = await createArmadaApiClient(auth);
  try {
    const result = await client.request<DockerLaunchResult>("/api/v1/sandbox/launch", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(600_000),
    });
    if (
      result?.sandbox?.provider !== "docker" ||
      result.sandbox.id !== requestId ||
      result.golden !== null ||
      !result.runtime?.epoch
    )
      throw new GoldenError(
        "invalid_config",
        "Docker launch outcome unknown: server did not confirm the requested logical sandbox.",
      );
    if (args.options.has("--json")) io.out(`${JSON.stringify(result, null, 2)}\n`);
    else
      io.out(
        `Docker sandbox: ${result.sandbox.providerSandboxId}\nArmada id: ${result.sandbox.id}\nStatus: ${result.sandbox.status}\n${result.promptId ? `Prompt: ${result.promptId}\n` : ""}`,
      );
    return 0;
  } catch (error) {
    io.err(
      `Docker launch request ${requestId}. Inspect this sandbox or retry with --request-id ${requestId} and the same body; do not create a replacement while outcome is unknown.\n`,
    );
    throw error;
  }
}
