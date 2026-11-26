import { AuthError } from "@armada/auth";
import {
  GoldenError,
  HARNESSES,
  type LaunchResult,
  MODEL_CATALOG,
  resolveModelChoice,
  SANDBOX_PLACEMENT_LABELS,
} from "@armada/core";
import { type ModalLaunchReceipt, parseLaunchAdmissionReceipt } from "@armada/core/contract";
import { requireLaunchAgent } from "../agent-validation.ts";
import { acceptedOptions, flag, parseArgs, providerFlag, single, usesHostLaunch, values } from "../args.ts";
import { rememberSandbox } from "../current-sandbox.ts";
import { prepareLaunch } from "../devx.ts";
import { launchDocker } from "../docker-launch.ts";
import { parseTtl } from "../operations.ts";
import { printOptionalResourceAdvice } from "../resource-advice.ts";
import { createSdkCommandClient } from "../sdk-session.ts";
import type { Command } from "./command.ts";

const agentChoices = HARNESSES.join("|");

type LaunchWireResult = Omit<LaunchResult, "expiresAt"> & { expiresAt?: string | null };

const run: Command["run"] = async (argv, { io, deps, auth }) => {
  argv = await prepareLaunch(argv, { ...auth, ...io });
  const args = parseArgs(
    argv,
    [
      "--skill",
      "--max-active-children",
      "--host",
      "--idempotency-key",
      "--credential-version",
      "--variable",
      "--secret",
      "--golden",
    ],
    ["--armada-access", "--keep-after-merge"],
  );
  if (usesHostLaunch(single(args, "--provider"))) {
    return launchDocker(args, io, { ...auth, fetch: deps.fetch ?? auth.fetch }, deps.sandboxFile);
  }
  if (["--host", "--credential-version", "--golden", "--variable", "--secret"].some((key) => args.options.has(key)))
    throw new GoldenError("invalid_config", "Docker placement flags require --provider docker.");
  acceptedOptions(args, "new", [
    "--provider",
    "--agent",
    "--model",
    "--reasoning-effort",
    "--credential-id",
    "--repo",
    "--ttl",
    "--skill",
    "--connections",
    "--no-connections",
    "--keep-after-merge",
    "--armada-access",
    "--max-active-children",
    "--idempotency-key",
    "--org",
    "--json",
  ]);
  const provider = providerFlag(args);
  if (provider === undefined) throw new GoldenError("invalid_config", "Pass --provider boat, modal, or docker.");
  const idempotencyKey = single(args, "--idempotency-key");
  if (idempotencyKey !== undefined && (idempotencyKey.length < 16 || idempotencyKey.length > 128))
    throw new GoldenError("invalid_config", "--idempotency-key requires 16–128 characters.");
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
  const client = await createSdkCommandClient({
    env: auth.env,
    fetch: deps.fetch ?? auth.fetch,
    session: auth.session,
    ...(auth.timeoutMs === undefined ? {} : { timeoutMs: auth.timeoutMs }),
  });
  const result = await client.sandboxes.launch<LaunchWireResult | ModalLaunchReceipt>(
    {
      ...(flag(args, "--no-connections") ? { connections: [] } : {}),
      ...(flag(args, "--keep-after-merge") ? { stopWhenWorkMerged: false } : {}),
      ...(values(args, "--skill").length ? { skills: values(args, "--skill") } : {}),
      ...(connections === undefined ? {} : { connections: connections.split(",").map((id) => id.trim()) }),
      ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
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
      provider,
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
  );
  if (!("golden" in result) && !parseLaunchAdmissionReceipt(provider, result))
    throw new AuthError(
      "Armada returned an invalid launch receipt. Run armada ls to check before retrying.",
      "unavailable",
    );
  if (result.sandbox.status !== "failed" && result.sandbox.status !== "deleted")
    await rememberSandbox(result.sandbox.id, deps.sandboxFile, io);
  if (flag(args, "--json")) {
    io.out(`${JSON.stringify(result, null, 2)}\n`);
  } else if ("golden" in result) {
    io.out(launchText(result, auth.now()));
    await printOptionalResourceAdvice(client, result.sandbox.id, single(args, "--org"), io.err);
  } else {
    io.out(`Sandbox: ${result.sandbox.id}\nStatus: ${result.sandbox.status}\n`);
  }
  return 0;
};

export default {
  name: "new",
  summary: "Launch an agent sandbox",
  usage: {
    "docker-launch": `  armada new [prompt] --provider docker [--host UUID|NAME | --golden snapshot-UUID] --agent ${agentChoices} [--credential-id UUID] [--org NAME|UUID] [--repo owner/repo[@branch] ...] [--variable KEY:UUID:VERSION ...] [--secret KEY:UUID:VERSION ...] [--idempotency-key KEY] [--json]
                                           Docker launch through the normal Armada API using the official Armada environment.`,
    new: `  armada new <snapshot> --agent ${agentChoices} ["prompt"] [--model <id>] [--reasoning-effort <level>]
                                           [--armada-access [--credential-id <id>] [--max-active-children <1..100>]]
                --provider boat|modal [--repo <configured-dir|owner/repo>] [--ttl 4h] [--json]
                [--skill org/slug@version|slug@version ...] [--connections <id,...> | --no-connections] [--org <org>]
                Omit connections to request server defaults; --no-connections opts out.
                                           Fork a snapshot into a sandbox. With a prompt the agent starts at once;
                                           without one the sandbox waits, ready, for the first prompt. The model
                                           and effort apply to every later turn too. --credential-id UUID selects a model account;
                                           otherwise use your personal or organization default.
                                           --repo selects the agent's initial working directory, including when idle.
                                           Defaults:
                                           ${modelDefaults()}`,
  },
  help: `Usage: armada new <snapshot> --provider boat|modal --agent ${agentChoices} ["prompt"] [options]
Fork a visible snapshot; a prompt starts the agent, otherwise wait for the first send.
Sign in with armada login or set ARMADA_TOKEN for scripts.
Find snapshots with armada snapshot ls; select an organization with --org or armada login --org NAME|UUID.

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
  armada new [prompt] --provider docker --agent ${agentChoices} [--org NAME|UUID]
    [--host UUID|NAME | --golden snapshot-UUID] [--credential-id UUID]
    [--repo owner/repo[@branch] ...] [--variable KEY:UUID:VERSION ...]
    [--secret KEY:UUID:VERSION ...] [--idempotency-key KEY] [--ttl <duration>] [--json]
    [--model <id>] [--reasoning-effort <level>] [--credential-version <version>]
    [--skill org/slug@version|slug@version ...] [--connections <id,...> | --no-connections]
Uses the official Armada environment or an existing host-local snapshot.
A snapshot cannot be combined with --repo.
Boat supports Claude, Codex and OpenCode with the server runtime.
Modal and Docker also support Antigravity.
--golden is the existing Docker snapshot selector, not a new snapshot command.
Reuse a saved --idempotency-key with identical input after an uncertain Docker outcome.

Inactivity can pause Boat and Modal sandboxes. Docker keeps running while idle.

In an interactive terminal, bare armada new opens the launcher.
Pass explicit arguments in scripts.
A successful launch saves the sandbox ID to .armada/sandbox in the current directory.
--json emits the launch response on stdout without human launch advice.
After an uncertain launch, inspect armada ls before retrying.
Example: armada new starter --provider modal --agent codex "Inspect the repository" --json
Example: armada new "Inspect the repository" --provider docker --host workstation --agent codex --org ORG_UUID
`,
  automaticJson: true,
  useSelectedOrg: true,
  run,
} satisfies Command;

function launchText(result: LaunchWireResult, now: Date) {
  const { sandbox, golden } = result;
  const lines = [
    `Launched ${sandbox.harness} sandbox from snapshot ${golden.name}.`,
    "Access: enforced by the server; metadata hints do not grant interior access.",
    `Sandbox: ${sandbox.id}`,
    `${SANDBOX_PLACEMENT_LABELS[sandbox.provider]} sandbox: ${sandbox.providerSandboxId}`,
    `Status: ${sandbox.status}`,
    ...(sandbox.machineSize
      ? [
          `Size: ${sandbox.machineSize.effective ?? "unknown (legacy)"} (requested ${sandbox.machineSize.requested ?? "none"}; source ${sandbox.machineSize.source}).`,
        ]
      : []),
    ...(sandbox.repositoryDir
      ? [`Repository context: ${sandbox.repositoryDir} (initial agent working directory, not an isolation boundary).`]
      : []),
    ...(sandbox.skills?.map((skill) => `Skill: ${skill.reference} (${skill.checksum})`) ?? []),
    `Model: ${sandbox.model ?? "provider default"} (reasoning effort ${sandbox.reasoningEffort ?? "default"})`,
  ];
  if (sandbox.credentialId)
    lines.push(`Credential account: ${sandbox.credentialId} (revision ${sandbox.credentialVersion}).`);
  if (result.conversationId) lines.push(`Conversation: ${result.conversationId}`);
  else lines.push("No prompt sent: the sandbox is ready for the first prompt.");
  lines.push(githubLine(result.github, now));
  if (result.github.status === "connected" && result.github.message) lines.push(`Note: ${result.github.message}`);
  lines.push(
    result.expiresAt
      ? `Stops by itself at ${new Date(result.expiresAt).toISOString()} (TTL ${result.ttlSeconds}s).`
      : `Stops by itself after ${result.ttlSeconds}s.`,
  );
  return `${lines.join("\n")}\n`;
}

function githubLine(github: LaunchResult["github"], now: Date) {
  if (github.status === "connected") {
    const expiry = github.tokenExpiresAt ? new Date(github.tokenExpiresAt) : null;
    const lifetime =
      expiry && Number.isFinite(expiry.getTime())
        ? `launch token expires at ${expiry.toISOString()} (~${Math.max(0, Math.floor((expiry.getTime() - now.getTime()) / 60_000))} minutes remaining)`
        : "launch token remaining lifetime unknown";
    return `GitHub: git and gh act as ${github.login} (${lifetime}; shared owner refresh may invalidate it earlier). Reconnect GitHub if needed and resume to re-resolve credentials.`;
  }
  return `GitHub: not set up. ${github.message ?? ""}`.trim();
}

function modelDefaults() {
  return Object.entries(MODEL_CATALOG)
    .map(([h, e]) => `${h} ${e.defaultModel} ${e.defaultReasoningEffort}`)
    .join(", ");
}
