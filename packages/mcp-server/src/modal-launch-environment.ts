import type { ExecEnvironment } from "@armada/agent-runtime";
import {
  type CredentialReader,
  type Harness,
  resolveCredentials,
  resolveGitHubAccess,
  type Sql,
  VaultError,
} from "@armada/core/server";
import type { HarnessEnvironment, Machine, Scope } from "@armada/provider-modal";
import { CREDENTIAL_BINDING_GUIDANCE } from "./credential-binding-recovery.ts";
import type { GitHubLaunchOptions } from "./launch-credentials.ts";

export interface ModalLaunchEnvironmentOptions {
  sql: Sql;
  vault: CredentialReader;
  encryptionKey: string | undefined;
  scope: Scope;
  scopeKey: string;
  callerUserId: string;
  github?: GitHubLaunchOptions;
}

/** Persist account identity/revision and GitHub opt-in; never resolve a different model account on restore. */
export function modalLaunchEnvironment(options: ModalLaunchEnvironmentOptions) {
  return async (
    machine: Machine,
    env: Readonly<Record<string, string>>,
  ): Promise<HarnessEnvironment & { execEnv: ExecEnvironment }> => {
    if (machine.golden) throw new VaultError("forbidden", "Golden builders cannot resolve launch credentials.");
    const claude = Boolean(env.CLAUDE_CODE_OAUTH_TOKEN || env.ANTHROPIC_API_KEY);
    const codex = Boolean(env.OPENAI_API_KEY || env.ARMADA_CODEX_AUTH_JSON);
    if (claude && codex) throw new VaultError("invalid", "A launch must select exactly one harness.");
    const initialHarness: Harness | undefined = claude ? "claude" : codex ? "codex" : undefined;
    if (env.GH_TOKEN && env.GITHUB_TOKEN && env.GH_TOKEN !== env.GITHUB_TOKEN)
      throw new VaultError("invalid", "Launch GitHub aliases disagree.");
    const selectedId = machine.info.labels.credentialId;
    const rawVersion = machine.info.labels.credentialVersion;
    const selectedVersion = rawVersion === undefined ? undefined : Number(rawVersion);
    if (
      (selectedId === undefined) !== (selectedVersion === undefined) ||
      (selectedVersion !== undefined && (!Number.isSafeInteger(selectedVersion) || selectedVersion < 1))
    )
      throw new VaultError("invalid", "Modal account binding is invalid.");
    if (initialHarness) {
      await options.sql.query(
        "insert into public.modal_server_harnesses(scope,machine_id,harness,github_enabled,credential_id,credential_version) values($1,$2,$3,$4,$5::uuid,$6::integer) on conflict(scope,machine_id) do nothing returning machine_id",
        [
          options.scopeKey,
          machine.info.id,
          initialHarness,
          Boolean(env.GH_TOKEN || env.GITHUB_TOKEN),
          selectedId ?? null,
          selectedVersion ?? null,
        ],
      );
    }
    const stored = (
      await options.sql.query<{
        harness: Harness;
        github_enabled: boolean;
        credential_id: string | null;
        credential_version: number | null;
      }>(
        "select harness,github_enabled,credential_id,credential_version from public.modal_server_harnesses where scope=$1 and machine_id=$2",
        [options.scopeKey, machine.info.id],
      )
    ).rows[0];
    if (!stored) throw new VaultError("unavailable", "Modal launch has no persisted harness identity.");
    if (initialHarness && stored.harness !== initialHarness)
      throw new VaultError("forbidden", "The launch harness identity cannot change.");
    if (selectedId !== undefined && stored.credential_id !== selectedId)
      throw new VaultError("forbidden", "Modal account identity cannot change.");
    if (selectedVersion !== undefined && stored.credential_version !== selectedVersion)
      throw new VaultError("forbidden", "Modal account revision cannot change.");
    if (!stored.credential_id) throw new VaultError("credential_binding_required", CREDENTIAL_BINDING_GUIDANCE);
    const userId = machine.launchUserId ?? options.callerUserId;
    const membership = await options.sql.query("select 1 from public.members where org_id=$1 and user_id=$2", [
      options.scope.orgId,
      userId,
    ]);
    if (!membership.rows.length)
      throw new VaultError("forbidden", "Launching user is no longer an organization member.");
    const credentials = await resolveCredentials(options.vault, options.encryptionKey, {
      orgId: options.scope.orgId,
      userId,
      harness: stored.harness,
      ...(stored.credential_id
        ? { credentialId: stored.credential_id, credentialVersion: stored.credential_version ?? 0 }
        : {}),
    });
    const execEnv: ExecEnvironment = {
      HOME: "/home/user",
      PATH: "/usr/local/bin:/usr/bin:/bin",
      GIT_TERMINAL_PROMPT: "0",
    };
    if (stored.github_enabled) {
      if (!options.github) throw new VaultError("unavailable", "This launch requires its GitHub connection.");
      const github = await resolveGitHubAccess({ ...options.github, encryptionKey: options.encryptionKey }, userId);
      if (github.status !== "connected")
        throw new VaultError(
          "unavailable",
          "GitHub access enabled for this launch is disconnected. Reconnect GitHub before restoring.",
        );
      execEnv.GH_TOKEN = github.token;
      execEnv.GITHUB_TOKEN = github.token;
    }
    // The runner is not ready during bootstrap. Scoped MCP reconciliation/configuration is
    // performed by #523 after init and by the admitted beforePrompt lifecycle hook on restore.
    // Match the launch contract: native agent Git tools need the same user identity as core exec.
    // Only the selected harness receives it; exec remains free of every model/provider credential.
    const githubEnv = execEnv.GH_TOKEN ? { GH_TOKEN: execEnv.GH_TOKEN, GITHUB_TOKEN: execEnv.GH_TOKEN } : {};
    return {
      claudeEnv:
        stored.harness === "claude"
          ? { HOME: "/home/user", PATH: execEnv.PATH!, ...credentials.env, ...githubEnv }
          : {},
      codexEnv:
        stored.harness === "codex" ? { HOME: "/home/user", PATH: execEnv.PATH!, ...credentials.env, ...githubEnv } : {},
      ...(stored.harness === "codex" && credentials.files[0] ? { codexAuthJson: credentials.files[0].content } : {}),
      execEnv,
    };
  };
}
