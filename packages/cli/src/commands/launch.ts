import {
  GoldenError,
  HARNESSES,
  type LaunchResult,
  launchResponse,
  MODEL_CATALOG,
  resolveModelChoice,
} from "@armada/core";
import { requireLaunchAgent } from "../agent-validation.ts";
import { flag, parseArgs, providerFlag, single, values } from "../args.ts";
import { createArmadaApiClient } from "../armada-api.ts";
import { prepareLaunch } from "../devx.ts";
import { launchDocker } from "../docker-launch.ts";
import { parseTtl } from "../operations.ts";
import { printOptionalResourceAdvice } from "../resource-advice.ts";
import type { Command } from "./command.ts";

type LaunchWireResult = Omit<LaunchResult, "expiresAt"> & { expiresAt?: string | null };

function decodeLaunchResult(result: LaunchWireResult) {
  const { expiresAt, ...launch } = result;
  return {
    ...launch,
    ...(expiresAt === null || expiresAt === undefined ? {} : { expiresAt: new Date(expiresAt) }),
  } satisfies LaunchResult;
}

const run: Command["run"] = async (argv, { io, deps, auth }) => {
  argv = await prepareLaunch(argv, { ...auth, ...io });
  const args = parseArgs(
    argv,
    [
      "--skill",
      "--max-active-children",
      "--host",
      "--image",
      "--request-id",
      "--credential-version",
      "--variable",
      "--secret",
      "--golden",
    ],
    ["--armada-access", "--keep-after-merge"],
  );
  if (single(args, "--provider") === "docker") {
    return launchDocker(args, io, { ...auth, fetch: deps.fetch ?? auth.fetch });
  }
  if (
    ["--host", "--image", "--request-id", "--credential-version", "--golden", "--variable", "--secret"].some(
      (key) => single(args, key) !== undefined,
    )
  )
    throw new GoldenError("invalid_config", "Docker placement flags require --provider docker.");
  const maxActiveChildren = single(args, "--max-active-children");
  if (
    maxActiveChildren !== undefined &&
    (!flag(args, "--armada-access") || !/^[1-9][0-9]*$/.test(maxActiveChildren) || Number(maxActiveChildren) > 100)
  )
    throw new GoldenError(
      "invalid_config",
      "--max-active-children requires --armada-access and a limit from 1 to 100.",
    );
  if (flag(args, "--no-connections") && single(args, "--connections") !== undefined)
    throw new GoldenError("invalid_config", "Use --connections or --no-connections, not both.");
  const legacyVisibility = single(args, "--visibility");
  if (legacyVisibility !== undefined) {
    if (legacyVisibility !== "private" && legacyVisibility !== "org")
      throw new GoldenError("invalid_config", "Legacy --visibility must be private or org.");
    io.err(
      "Warning: --visibility is deprecated and ignored. The server enforces sandbox access and resolves omitted connection defaults.\n",
    );
  }
  const connections = single(args, "--connections");
  if (connections !== undefined && connections.split(",").some((id) => !id.trim()))
    throw new GoldenError(
      "invalid_config",
      "--connections needs a comma-separated list of nonempty IDs; use --no-connections to opt out.",
    );
  const [name, prompt, ...extra] = args.positionals;
  if (name === undefined || extra.length > 0) {
    throw new GoldenError("invalid_config", "Give a snapshot name and at most one prompt.");
  }
  const harness = requireLaunchAgent(single(args, "--agent"));
  const repo = single(args, "--repo");
  resolveModelChoice(harness, { model: single(args, "--model"), reasoningEffort: single(args, "--reasoning-effort") });
  const ttl = single(args, "--ttl");
  const ttlSeconds = ttl === undefined ? undefined : parseTtl(ttl);
  const client = await createArmadaApiClient({
    env: auth.env,
    fetch: deps.fetch ?? auth.fetch,
    session: auth.session,
    ...(auth.timeoutMs === undefined ? {} : { timeoutMs: auth.timeoutMs }),
  });
  const result = decodeLaunchResult(
    await client.sandboxes.launch<LaunchWireResult>(
      {
        ...(flag(args, "--no-connections") ? { connections: [] } : {}),
        ...(flag(args, "--keep-after-merge") ? { stopWhenWorkMerged: false } : {}),
        ...(values(args, "--skill").length ? { skills: values(args, "--skill") } : {}),
        ...(connections === undefined ? {} : { connections: connections.split(",") }),
        ...(flag(args, "--armada-access")
          ? {
              armadaAccessVersion: 1,
              armadaAccess: {
                ...(maxActiveChildren === undefined ? {} : { maxActiveChildren: Number(maxActiveChildren) }),
              },
            }
          : {}),
        credentialId: single(args, "--credential-id"),
        golden: name,
        ...(repo === undefined ? {} : { repo }),
        ...(providerFlag(args) ? { provider: providerFlag(args) } : {}),
        harness,
        ...(single(args, "--model") === undefined ? {} : { model: single(args, "--model") }),
        ...(single(args, "--reasoning-effort") === undefined
          ? {}
          : { reasoningEffort: single(args, "--reasoning-effort") }),
        ...(prompt === undefined ? {} : { prompt }),
        ...(ttlSeconds === undefined ? {} : { ttlSeconds }),
        ...(single(args, "--org") === undefined ? {} : { org: single(args, "--org") }),
      },
      { signal: AbortSignal.timeout(10 * 60_000) },
    ),
  );
  io.out(
    flag(args, "--json")
      ? `${JSON.stringify(
          {
            ...launchResponse(result),
            sandbox: result.sandbox,
            runtime: result.runtime ?? null,
            helper: result.helper ?? null,
            conversationId: result.conversationId ?? null,
          },
          null,
          2,
        )}\n`
      : launchText(result, auth.now()),
  );
  if (!flag(args, "--json"))
    await printOptionalResourceAdvice(client, result.sandbox.id, single(args, "--org"), io.err);
  return 0;
};

export default {
  name: "launch",
  summary: "Launch an agent sandbox",
  usage: {
    "docker-launch": `  armada launch [prompt] --provider docker [--host UUID|NAME | --golden snapshot-UUID] --agent claude|codex|opencode [--credential-id UUID] [--org NAME|UUID] [--repo owner/repo[@branch] ...] [--variable KEY:UUID:VERSION ...] [--secret KEY:UUID:VERSION ...] [--request-id UUID] [--json]
                                           Docker launch through the normal Armada API using the official Armada environment.`,
    launch: `  armada launch <snapshot> --agent ${HARNESSES.join("|")} ["prompt"] [--model <id>] [--reasoning-effort <level>]
                                           [--armada-access [--credential-id <id>] [--max-active-children <1..100>]]
                [--provider boat|modal] [--repo <configured-dir|owner/repo>] [--ttl 4h] [--json]
                [--skill org/slug@version|slug@version ...] [--connections <id,...> | --no-connections] [--org <org>]
                Omit connections to request server defaults; --no-connections opts out.
                                           Fork a snapshot into a sandbox. With a prompt the agent starts at once;
                                           without one the sandbox waits, ready, for the first prompt. The model
                                           and effort apply to every later turn too. --credential-id UUID selects a model account;
                                           otherwise use your personal or organization default.
                                           --repo selects the native agent's initial working directory, including when idle.
                                           Defaults:
                                           ${modelDefaults()}`,
  },
  help: `Usage: armada launch <snapshot> --agent claude|codex|opencode ["prompt"] [options]
Fork a visible snapshot; a prompt starts the agent, otherwise wait for the first send.
Sign in with armada login or set ARMADA_TOKEN for scripts.
Find snapshots with armada snapshot list; select an organization with --org or armada org use.

Boat/Modal options:
  --provider boat|modal                  Select the snapshot provider.
  --model <id> --reasoning-effort <level> Model settings also apply to later turns.
  --credential-id UUID                   Model account; otherwise personal/org default.
  --repo <configured-dir|owner/repo>      Initial repository cwd, not confinement.
  --ttl <duration>                       Sandbox lifetime, for example 4h.
  --skill org/slug@version|slug@version   Repeat for multiple skills.
  --connections <id,...>                 Explicit MCP connections.
  --no-connections                       Opt out; omission uses server defaults.
  --keep-after-merge                     Disable automatic stopping after merged work.
  --armada-access                        Enable scoped Armada child access.
  --max-active-children <1..100>          Requires --armada-access.
  --org <org> --json                     Organization selector and machine output.

Docker form:
  armada launch [prompt] --provider docker --agent claude|codex|opencode [--org NAME|UUID]
    [--host UUID|NAME | --golden snapshot-UUID] [--credential-id UUID]
    [--repo owner/repo[@branch] ...] [--variable KEY:UUID:VERSION ...]
    [--secret KEY:UUID:VERSION ...] [--request-id UUID] [--ttl <duration>] [--json]
    [--model <id>] [--reasoning-effort <level>] [--credential-version <version>]
    [--skill org/slug@version|slug@version ...] [--connections <id,...> | --no-connections]
Uses the official Armada environment or an existing host-local snapshot.
A snapshot cannot be combined with --repo.
Boat supports Claude/Codex natively and OpenCode when the server runtime is installed.
OpenCode is also supported on Modal and Docker.
--golden is the existing Docker snapshot selector, not a new snapshot command.
Reuse a saved --request-id with identical input after an uncertain Docker outcome.

In an interactive terminal, bare armada launch opens the launcher.
Use explicit arguments in scripts; bare noninteractive launch is not supported.
--json emits the launch response on stdout without human launch advice.
After an uncertain launch, inspect armada list before retrying.
Example: armada launch starter --provider modal --agent codex "Inspect the repository" --json
Example: armada launch "Inspect the repository" --provider docker --host workstation --agent codex --org ORG_UUID
`,
  run,
} satisfies Command;

function launchText(result: LaunchResult, now: Date) {
  const { sandbox, golden } = result;
  const lines = [
    `Launched ${sandbox.harness} sandbox from snapshot ${golden.name}.`,
    "Access: enforced by the server; metadata hints do not grant interior access.",
    `Sandbox: ${sandbox.id}`,
    `${sandbox.provider === "boat" ? "Boat" : "Modal"} sandbox: ${sandbox.providerSandboxId}`,
    `Status: ${sandbox.status}`,
    ...(sandbox.machineSize
      ? [
          `Size: ${sandbox.machineSize.effective ?? "unknown (legacy)"} (requested ${sandbox.machineSize.requested ?? "none"}; source ${sandbox.machineSize.source}).`,
        ]
      : []),
    ...(sandbox.repositoryDir
      ? [`Repository context: ${sandbox.repositoryDir} (native agent cwd; not an isolation boundary).`]
      : []),
    ...(sandbox.skills?.map((skill) => `Skill: ${skill.reference} (${skill.checksum})`) ?? []),
    `Model: ${sandbox.model ?? "provider default"} (reasoning effort ${sandbox.reasoningEffort ?? "default"})`,
  ];
  if (sandbox.credentialId)
    lines.push(`Credential account: ${sandbox.credentialId} (revision ${sandbox.credentialVersion}).`);
  if (result.conversationId) lines.push(`Conversation: ${result.conversationId}`);
  else lines.push("No prompt sent: the sandbox is ready for the first prompt.");
  lines.push(githubLine(result, now));
  if (result.github.status === "connected" && result.github.message) lines.push(`Note: ${result.github.message}`);
  lines.push(
    result.expiresAt
      ? `Stops by itself at ${new Date(result.expiresAt).toISOString()} (TTL ${result.ttlSeconds}s).`
      : `Stops by itself after ${result.ttlSeconds}s.`,
  );
  return `${lines.join("\n")}\n`;
}

function githubLine(result: LaunchResult, now: Date) {
  const { github } = result;
  if (github.status === "connected") {
    const expiry = github.tokenExpiresAt ? new Date(github.tokenExpiresAt) : null;
    const lifetime =
      expiry && Number.isFinite(expiry.getTime())
        ? `launch token expires at ${expiry.toISOString()} (~${Math.max(0, Math.floor((expiry.getTime() - now.getTime()) / 60_000))} minutes remaining)`
        : "launch token remaining lifetime unknown";
    const repair =
      result.sandbox.provider === "boat"
        ? `Use armada github refresh ${result.sandbox.id} for a running legacy sandbox; automatic next-prompt repair is experimental and off by default.`
        : "Reconnect GitHub if needed and resume to re-resolve credentials.";
    return `GitHub: git and gh act as ${github.login} (${lifetime}; shared owner refresh may invalidate it earlier). ${repair}`;
  }
  return `GitHub: not set up. ${github.message ?? ""}`.trim();
}

function modelDefaults() {
  return Object.entries(MODEL_CATALOG)
    .map(([h, e]) => `${h} ${e.defaultModel} ${e.defaultReasoningEffort}`)
    .join(", ");
}
