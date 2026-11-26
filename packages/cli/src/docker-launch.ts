import { AuthError } from "@armada/auth";
import {
  configFromFlags,
  type DockerLaunchRequest,
  GoldenError,
  MAX_MCP_CONNECTIONS,
  parseApplicationSecretBindings,
  parseReadableVariableBindings,
  resolveModelChoice,
  validateSkillPins,
} from "@armada/core";
import { parseLaunchAdmissionReceipt } from "@armada/core/contract";
import { requireLaunchAgent } from "./agent-validation.ts";
import { ArmadaApiError } from "./api-responses.ts";
import { type Args, flag, single, values } from "./args.ts";
import type { AuthIo } from "./auth-commands.ts";
import { type CurrentSandboxFile, rememberSandbox } from "./current-sandbox.ts";
import { resolveHost, resolveHostOrganization } from "./host-commands.ts";
import { parseTtl } from "./operations.ts";
import { createSdkCommandClient } from "./sdk-session.ts";

const uuid = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
export async function launchDocker(
  args: Args,
  io: Pick<AuthIo, "out" | "err">,
  auth: AuthIo,
  sandboxFile?: CurrentSandboxFile,
): Promise<number> {
  const allowed = new Set([
    "--repo",
    "--variable",
    "--secret",
    "--provider",
    "--host",
    "--golden",
    "--credential-id",
    "--credential-version",
    "--idempotency-key",
    "--agent",
    "--org",
    "--model",
    "--reasoning-effort",
    "--ttl",
    "--json",
    "--skill",
    "--connections",
    "--no-connections",
    "--keep-after-merge",
  ]);
  if ([...args.options.keys()].some((key) => !allowed.has(key)) || args.positionals.length > 1)
    throw new GoldenError("invalid_config", "Docker launch takes at most one prompt and no snapshot or size.");
  const harness = requireLaunchAgent(single(args, "--agent"));
  const requiredId = (flag: string) => {
    const value = single(args, flag);
    if (!value || !uuid.test(value))
      throw new GoldenError("invalid_config", `${flag} requires a UUID for Docker launch.`);
    return value.toLowerCase();
  };
  const org = single(args, "--org");
  const credentialId = single(args, "--credential-id") === undefined ? undefined : requiredId("--credential-id");
  const snapshotId = single(args, "--golden");
  if (snapshotId !== undefined && !uuid.test(snapshotId))
    throw new GoldenError("invalid_config", "--golden requires a Docker snapshot UUID.");
  const selector = single(args, "--host");
  if (!snapshotId && selector === undefined)
    throw new GoldenError("invalid_config", "Docker launch requires --host UUID|NAME or --golden SNAPSHOT_UUID.");
  if (selector !== undefined && (!selector || selector.length > 64 || /[\p{C}]/u.test(selector)))
    throw new GoldenError("invalid_config", "--host requires a UUID or exact host name.");
  if (snapshotId && values(args, "--repo").length)
    throw new GoldenError("invalid_config", "A snapshot cannot be combined with --repo.");
  const supplied = single(args, "--idempotency-key");
  if (supplied !== undefined && (supplied.length < 16 || supplied.length > 128))
    throw new GoldenError("invalid_config", "--idempotency-key requires 16–128 characters.");
  const idempotencyKey = supplied ?? crypto.randomUUID();
  const version = single(args, "--credential-version");
  if (version !== undefined && (!/^[1-9][0-9]*$/.test(version) || !Number.isSafeInteger(Number(version))))
    throw new GoldenError("invalid_config", "--credential-version must be a positive integer.");
  if (version !== undefined && credentialId === undefined)
    throw new GoldenError("invalid_config", "--credential-version requires --credential-id.");
  const ttl = single(args, "--ttl");
  const repos = values(args, "--repo");
  const variables = values(args, "--variable").map((binding) => {
    const [key, variableId, version, extra] = binding.split(":");
    if (extra !== undefined || !version || !/^[1-9][0-9]*$/.test(version))
      throw new GoldenError("invalid_config", "Use --variable KEY:UUID:VERSION.");
    return { key, variableId, version: Number(version) };
  });
  let variableBindings: ReturnType<typeof parseReadableVariableBindings>;
  try {
    variableBindings = parseReadableVariableBindings(variables);
  } catch {
    throw new GoldenError("invalid_config", "Invalid readable variable bindings.");
  }
  let secretBindings: ReturnType<typeof parseApplicationSecretBindings>;
  try {
    secretBindings = parseApplicationSecretBindings(
      values(args, "--secret").map((binding) => {
        const [key, secretId, version, extra] = binding.split(":");
        if (extra !== undefined || !version || !/^[1-9][0-9]*$/.test(version)) throw Error("Invalid secret binding.");
        return { key, secretId, version: Number(version) };
      }),
    );
    if (
      variableBindings.length + secretBindings.length > 64 ||
      secretBindings.some((secret) => variableBindings.some((variable) => secret.key === variable.key))
    )
      throw Error("Invalid environment bindings.");
  } catch {
    throw new GoldenError("invalid_config", "Invalid application secret bindings. Use --secret KEY:UUID:VERSION.");
  }
  resolveModelChoice(harness, { model: single(args, "--model"), reasoningEffort: single(args, "--reasoning-effort") });
  const skills = values(args, "--skill");
  try {
    validateSkillPins(skills);
  } catch {
    throw new GoldenError("invalid_config", "Skills require exact pins.");
  }
  const connections = single(args, "--connections");
  if (flag(args, "--no-connections") && connections !== undefined)
    throw new GoldenError("invalid_config", "Use --connections or --no-connections, not both.");
  const selected = connections?.split(",").map((id) => id.trim());
  if (selected && (selected.length > MAX_MCP_CONNECTIONS || selected.some((id) => !uuid.test(id))))
    throw new GoldenError("invalid_config", `Connections require 1–${MAX_MCP_CONNECTIONS} comma-separated UUIDs.`);
  const client = await createSdkCommandClient(auth, { preserveServerErrors: true });
  const hostId = selector
    ? uuid.test(selector)
      ? selector.toLowerCase()
      : await resolveHost(client, await resolveHostOrganization(client, org), selector)
    : undefined;
  const body: DockerLaunchRequest = {
    ...(secretBindings.length ? { secrets: secretBindings } : {}),
    ...(variableBindings.length ? { variables: variableBindings } : {}),
    ...(repos.length
      ? {
          repos: configFromFlags(
            repos.map((repo) =>
              /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:@.+)?$/.test(repo) ? `https://github.com/${repo}` : repo,
            ),
            [],
          ).repos,
        }
      : {}),
    ...(org === undefined ? {} : { org }),
    provider: "docker",
    ...(hostId ? { hostId } : {}),
    ...(snapshotId ? { snapshotId } : {}),
    harness,
    ...(credentialId === undefined ? {} : { credentialId }),
    idempotencyKey,
    ...(single(args, "--model") === undefined ? {} : { model: single(args, "--model")! }),
    ...(single(args, "--reasoning-effort") === undefined
      ? {}
      : { reasoningEffort: single(args, "--reasoning-effort")! }),
    ...(skills.length ? { skills } : {}),
    ...(flag(args, "--keep-after-merge") ? { stopWhenWorkMerged: false } : {}),
    ...(flag(args, "--no-connections") ? { connections: [] } : selected ? { connections: selected } : {}),
    ...(version === undefined ? {} : { credentialVersion: Number(version) }),
    ...(ttl === undefined ? {} : { ttlSeconds: parseTtl(ttl) }),
    ...(args.positionals[0] === undefined ? {} : { prompt: args.positionals[0] }),
  };
  try {
    const response = await client.sandboxes.launch<unknown>(body, {
      signal: AbortSignal.timeout(600_000),
    });
    const result = parseLaunchAdmissionReceipt("docker", response);
    if (!result)
      throw new AuthError(
        "Docker launch outcome unknown: server did not confirm the requested logical sandbox.",
        "unavailable",
      );
    if (result.sandbox.status !== "failed" && result.sandbox.status !== "deleted")
      await rememberSandbox(result.sandbox.id, sandboxFile, io);
    if (flag(args, "--json")) io.out(`${JSON.stringify(result, null, 2)}\n`);
    else io.out(`Armada id: ${result.sandbox.id}\nStatus: ${result.sandbox.status}\n`);
    return 0;
  } catch (error) {
    if (
      !(
        error instanceof ArmadaApiError &&
        (error.serverCode === "provider_routing_unavailable" ||
          (error.status < 500 && error.serverCode !== "outcome_unknown"))
      ) &&
      !(error instanceof AuthError && error.code === "unauthorized")
    )
      io.err(
        `Docker launch key ${JSON.stringify(idempotencyKey)}. Retry with --idempotency-key and the same key and body; do not create a replacement while outcome is unknown.\n`,
      );
    throw error;
  }
}
