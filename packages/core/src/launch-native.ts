import { CODEX_AUTH_ENV, redact } from "./credentials.ts";
import { GH_MISSING_NOTE, GH_PRESENT_MARKER, type GitIdentity, gitSetupCommand } from "./github.ts";
import { GOLDEN_ROOT } from "./golden-config.ts";
import type { GitHubLaunchInfo } from "./launch.ts";
import { LaunchError } from "./launch-error.ts";
import { type LaunchStrategy, requireLaunchHeadroom } from "./launch-strategy.ts";
import { launchCommandOutput, prepareLaunchWorkspace } from "./launch-workspace.ts";
import { PrivateSkillError } from "./private-skill-error.ts";
import type { Provider } from "./provider.ts";
import { launchInfrastructure } from "./sandbox-provider.ts";
import { installSkill, skillExclusionCommand } from "./skillpack.ts";

export const nativeLaunch: LaunchStrategy = {
  kind: "native",
  forkEnv: (plan) => plan.env,
  recordFields: ({ connected, golden }) =>
    connected?.connectionEpoch
      ? {
          pullRequestSource: {
            connectionEpoch: connected.connectionEpoch,
            repositories: golden.config.repos.map(({ url, dir, branch }) => ({ url, dir, branch })),
          },
        }
      : {},
  async initialize(plan, { actor, launchId, record, providerSandboxId, signal, progress, mark, reportGitHub }) {
    const {
      provider,
      stores,
      request,
      options,
      golden,
      harness,
      repositoryDir,
      prepareNativeCwd,
      credentials,
      github,
      connected,
      secrets,
    } = plan;
    progress("initialization_hydrate");
    if (
      credentials.codexAuthJson &&
      !(await stores.credentials.hydrateNative?.(actor, credentials, launchId, provider, providerSandboxId))
    )
      await writeCodexAuth(provider, providerSandboxId, secrets);
    progress("initialization_github");
    const launchGithub: GitHubLaunchInfo =
      github.status === "connected"
        ? await setupGitHub(provider, providerSandboxId, github.identity, secrets)
        : { status: github.status, message: github.message };
    if (github.status === "connected" && github.expiresAt) launchGithub.tokenExpiresAt = github.expiresAt.toISOString();
    const warnings = await prepareLaunchWorkspace(
      provider,
      providerSandboxId,
      record.id,
      golden,
      secrets,
      progress,
      options.sleep,
      undefined,
      connected !== null,
    );
    if (warnings.length) launchGithub.message = [launchGithub.message, ...warnings].filter(Boolean).join(" ");
    await mark("checkout_done");
    progress("initialization_cwd");
    if (repositoryDir !== null && prepareNativeCwd)
      await prepareNativeCwd({ sandboxId: providerSandboxId, harness, cwd: `${GOLDEN_ROOT}/${repositoryDir}` });
    if (request.skills?.length) {
      const receipts = [];
      let privateKey: string | null | undefined;
      for (const skill of request.skills) {
        const projectDir = repositoryDir === null ? GOLDEN_ROOT : `${GOLDEN_ROOT}/${repositoryDir}`;
        if (!skill.includes("/")) {
          if (!stores.credentials.installPrivateSkill)
            throw new PrivateSkillError("skillpack_transport_failed", "transport");
          if (privateKey === undefined) privateKey = (await stores.credentials.skillpackKey?.(actor)) ?? null;
          receipts.push(
            await stores.credentials.installPrivateSkill(provider, {
              sandboxId: providerSandboxId,
              projectDir,
              reference: skill,
              harness,
              key: privateKey,
              ...(golden.buildWarnings ? { buildWarnings: golden.buildWarnings } : {}),
            }),
          );
        } else
          receipts.push(
            await installSkill(provider, providerSandboxId, projectDir, harness, skill, golden.buildWarnings),
          );
      }
      if (repositoryDir !== null) {
        // Local Git metadata only: do not stage third-party launch skills with worker changes.
        const excluded = await provider.exec({
          sandboxId: providerSandboxId,
          cwd: `${GOLDEN_ROOT}/${repositoryDir}`,
          timeoutSeconds: 30,
          command: skillExclusionCommand(request.skills, harness),
        });
        if (excluded.detached || excluded.timedOut || excluded.truncated || excluded.exitCode !== 0)
          throw new Error("Skillpack checkout exclusions could not be prepared.");
      }
      await stores.sandboxes.recordSkills!(record.id, receipts);
      record.skills = receipts;
    }
    progress("initialization_mcp");
    requireLaunchHeadroom(record);
    await stores.connections?.prepare?.(provider, record, actor, signal);
    await options.beforeStart?.(provider, record);
    reportGitHub(launchGithub);
    // Boat goldens carry the native CLI. A restored fork can be ready while its
    // executable cannot even boot; probe the installed wrapper (including its
    // harness-only readable environment) without creating a session or model turn.
    // Modal validates its separately distributed native runtime at installation.
    if (launchInfrastructure(provider.id).nativeCli) {
      try {
        const health = await provider.exec({
          sandboxId: providerSandboxId,
          command: `${harness} --version >/dev/null 2>&1`,
          cwd: repositoryDir === null ? GOLDEN_ROOT : `${GOLDEN_ROOT}/${repositoryDir}`,
          timeoutSeconds: 15,
          signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]),
        });
        if (health.detached || health.timedOut || health.truncated || health.exitCode !== 0)
          throw new Error("harness_health_failed");
      } catch {
        // Fixed text only: native boot errors can include paths or credentials.
        // Reuse the existing public code; iPhone clients decode closed lists.
        throw new LaunchError(
          "start_failed",
          "The agent runtime could not start in this sandbox. Relaunch in a new sandbox.",
        );
      }
    }
    return { github: launchGithub, prompt: (request) => provider.prompt(request) };
  },
};

/** Identity and the credential helper, before any repo is pulled. A failure here is a broken sandbox, so it fails the launch. */
async function setupGitHub(
  provider: Provider,
  sandboxId: string,
  identity: GitIdentity,
  secrets: readonly string[],
): Promise<GitHubLaunchInfo> {
  const result = await provider.exec({
    sandboxId,
    command: gitSetupCommand(identity),
    cwd: GOLDEN_ROOT,
    timeoutSeconds: 60,
  });
  if (result.detached)
    throw new LaunchError("start_failed", "GitHub setup started in the background.", {
      safeReason: "github_setup_background",
    });
  if (result.timedOut || result.exitCode !== 0) {
    throw new LaunchError(
      "start_failed",
      `GitHub could not be set up in the sandbox.${launchCommandOutput(result.stderr, result.stdout, secrets)}`,
      { safeReason: result.timedOut ? "github_setup_timeout" : "github_setup_nonzero" },
    );
  }
  const present = result.stdout.includes(GH_PRESENT_MARKER);
  return { status: "connected", login: identity.login, ...(present ? {} : { message: GH_MISSING_NOTE }) };
}

async function writeCodexAuth(provider: Provider, sandboxId: string, secrets: readonly string[]): Promise<void> {
  const dir = `${GOLDEN_ROOT}/.codex`;
  const command = `umask 077 && mkdir -p ${dir} && printf '%s' "$${CODEX_AUTH_ENV}" > ${dir}/auth.json`;
  const result = await provider.exec({ sandboxId, command, cwd: GOLDEN_ROOT, timeoutSeconds: 60 });
  if (result.detached || result.timedOut || result.exitCode !== 0) {
    throw new LaunchError("start_failed", redact("Codex auth.json could not be written in the sandbox.", secrets), {
      safeReason: "native_auth_write_failed",
    });
  }
}
