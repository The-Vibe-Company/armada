import type { CredentialReader } from "@armada/core";
import { type LaunchOptions, PROVIDER_LIMITS, resolveBoatKey, SANDBOX_STOP_MARGIN_SECONDS } from "@armada/core/server";
import { createBoatProvider } from "@armada/provider-boat";
import { launchCredentials } from "./launch-credentials.ts";
import type { ModelAuthOwnership } from "./model-auth.ts";
import type { RuntimeResumePrepare } from "./runtime-resume.ts";

/** Compute activation is isolated from legacy native harness/GitHub/MCP hooks. */
export function boatRuntimeResume(options: {
  vault: CredentialReader;
  key: string;
  policy: NonNullable<LaunchOptions["boatRuntime"]>;
  modelAuth: ModelAuthOwnership;
}): RuntimeResumePrepare {
  return async (caller, sandbox) => {
    const actor = { userId: caller.userId, orgId: sandbox.orgId, role: "member" as const };
    const credentials = await launchCredentials(options.vault, options.key, undefined, options.modelAuth).resolve(
      actor,
      "codex",
      sandbox.credentialId ?? undefined,
      sandbox.credentialVersion ?? undefined,
    );
    const management = await resolveBoatKey(options.vault, options.key, {
      userId: caller.userId,
      orgId: sandbox.orgId,
      visibility: sandbox.sourceGoldenVisibility ?? sandbox.visibility ?? "private",
    });
    const host = createBoatProvider({ apiKey: management.key });
    return {
      async start(signal, restoreCheckpoint) {
        return options.policy.start({
          host,
          actor,
          sandbox,
          credentials,
          signal,
          restoreCheckpoint,
          activate: async (admission) => {
            const current = await host.get(sandbox.providerSandboxId, { signal: admission });
            if (current.state !== "stopped") throw Error("runtime_resume_requires_stopped_compute");
            await host.resumeRuntime(
              sandbox.providerSandboxId,
              Math.min(
                PROVIDER_LIMITS.boat.maxTtlSeconds,
                (sandbox.effectiveTtlSeconds ?? 14400) + SANDBOX_STOP_MARGIN_SECONDS,
              ),
              admission,
            );
          },
        });
      },
      stop: () => host.stopBestEffort(sandbox.providerSandboxId),
    };
  };
}
