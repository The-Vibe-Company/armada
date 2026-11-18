import { AuthError } from "@armada/auth";
import {
  configFromFlags,
  type DockerLaunchRequest,
  type DockerLaunchResult,
  GoldenError,
  MAX_MCP_CONNECTIONS,
  parseApplicationSecretBindings,
  parseReadableVariableBindings,
  resolveModelChoice,
  validateSkillPins,
} from "@armada/core";
import { requireLaunchAgent } from "./agent-validation.ts";
import { type Args, flag, single, values } from "./args.ts";
import { ArmadaApiError, createArmadaApiClient } from "./armada-api.ts";
import type { AuthIo } from "./auth-commands.ts";
import { resolveHost, resolveHostOrganization } from "./host-commands.ts";
import { parseTtl } from "./operations.ts";

const uuid = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
/** API-only plain-image launch. No golden, provider credential or database dependency. */
export async function launchDocker(args: Args, io: Pick<AuthIo, "out" | "err">, auth: AuthIo): Promise<number> {
  const allowed = new Set([
    "--repo",
    "--variable",
    "--secret",
    "--provider",
    "--host",
    "--golden",
    "--credential-id",
    "--credential-version",
    "--request-id",
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
  const supplied = single(args, "--request-id");
  if (supplied !== undefined && !uuid.test(supplied))
    throw new GoldenError("invalid_config", "--request-id requires a UUID.");
  const requestId = supplied?.toLowerCase() ?? crypto.randomUUID();
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
  const client = await createArmadaApiClient(auth, { preserveServerErrors: true });
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
    requestId,
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
    const result = await client.sandboxes.launch<DockerLaunchResult>(body, {
      signal: AbortSignal.timeout(600_000),
    });
    if (
      result?.sandbox?.provider !== "docker" ||
      result.sandbox.id !== requestId ||
      result.golden !== null ||
      (!result.runtime?.epoch && !(result.runtime === null && ["starting", "failed"].includes(result.sandbox.status)))
    )
      throw new GoldenError(
        "invalid_config",
        "Docker launch outcome unknown: server did not confirm the requested logical sandbox.",
      );
    if (args.options.has("--json"))
      io.out(
        `${JSON.stringify(
          {
            ...result,
            id: result.sandbox.id,
            provider: result.sandbox.provider,
            status: result.sandbox.status,
            promptId: result.promptId ?? null,
            conversationId: result.conversationId ?? null,
          },
          null,
          2,
        )}\n`,
      );
    else
      io.out(
        `Docker sandbox: ${result.sandbox.providerSandboxId}\nArmada id: ${result.sandbox.id}\nStatus: ${result.sandbox.status}\n${result.promptId ? `Prompt: ${result.promptId}\n` : ""}${result.github?.message ? `Note: ${result.github.message}\n` : ""}${result.sandbox.statusReason ? `Reason: ${result.sandbox.statusReason}\n` : ""}`,
      );
    return 0;
  } catch (error) {
    // A structured refusal is definitive; transport failures, malformed receipts and
    // server/gateway failures still need the stable request identity for recovery.
    if (
      !(
        error instanceof ArmadaApiError &&
        (error.serverCode === "provider_routing_unavailable" ||
          (error.status < 500 && error.serverCode !== "outcome_unknown"))
      ) &&
      !(error instanceof AuthError && error.code === "unauthorized")
    )
      io.err(
        `Docker launch request ${requestId}. Inspect this sandbox or retry with --request-id ${requestId} and the same body; do not create a replacement while outcome is unknown.\n`,
      );
    throw error;
  }
}
