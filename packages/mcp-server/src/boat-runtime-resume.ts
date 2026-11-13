import type { CredentialReader } from "@armada/core";
import {
  type LaunchOptions,
  PROVIDER_LIMITS,
  resolveBoatKey,
  SANDBOX_STOP_MARGIN_SECONDS,
  type Sql,
} from "@armada/core/server";
import { createBoatProvider } from "@armada/provider-boat";
import { launchCredentials } from "./launch-credentials.ts";
import type { ModelAuthOwnership } from "./model-auth.ts";
import type { RuntimeResumePrepare } from "./runtime-resume.ts";

/** Compute activation is isolated from legacy native harness/GitHub/MCP hooks. */
export function boatRuntimeResume(options: {
  vault: CredentialReader;
  sql: Sql;
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
            if (current.state !== "stopped" || current.physicalExitConfirmed)
              throw Error("runtime_resume_requires_stopped_compute");
            const admissionRow = (
              await options.sql.query(
                `select s.id from public.sandboxes s join public.runtime_enrolments r on r.sandbox_id=s.id
              join public.credentials c on c.id=s.credential_id and c.version=s.credential_version
              where s.id=$1 and s.owner_id=$2 and s.lifecycle_generation=$3 and s.status='starting'
              and s.activity_lease_id is not null and s.stop_requested_at is null and s.deleted_at is null and not s.application_secret_tainted
              and r.epoch=$4 and c.status='active' and (c.expires_at is null or c.expires_at>now())
              and exists(select 1 from public.members m where m.user_id=s.owner_id and m.org_id=s.org_id)`,
                [sandbox.id, caller.userId, sandbox.lifecycleGeneration, restoreCheckpoint.epoch],
              )
            ).rows[0];
            if (!admissionRow) throw Error("runtime_resume_admission_changed");
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
