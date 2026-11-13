import type { CredentialReader, LaunchOptions, ProviderTarget, Sql } from "@armada/core/server";
import { PROVIDER_LIMITS, SANDBOX_STOP_MARGIN_SECONDS } from "@armada/core/server";
import type { ModalProvider } from "@armada/provider-modal";
import type { Caller } from "./caller.ts";
import { launchCredentials } from "./launch-credentials.ts";
import type { RuntimeResumePrepare } from "./runtime-resume.ts";

/** Modal owns retained compute only; common resume owns epoch, checkpoint and native session proof. */
export function modalRuntimeResume(options: {
  sql: Sql;
  vault: CredentialReader;
  key: string;
  policy: NonNullable<LaunchOptions["runtime"]>;
  hostFor(target: ProviderTarget, caller: Caller): Promise<ModalProvider>;
}): RuntimeResumePrepare {
  return async (caller, sandbox) => {
    const actor = { userId: caller.userId, orgId: sandbox.orgId, role: "member" as const };
    const credentials = await launchCredentials(options.vault, options.key).resolve(
      actor,
      sandbox.harness,
      sandbox.credentialId ?? undefined,
      sandbox.credentialVersion ?? undefined,
    );
    const host = await options.hostFor(sandbox, caller);
    return {
      start: (signal, restoreCheckpoint) =>
        options.policy.start({
          host,
          actor,
          sandbox,
          credentials,
          signal,
          restoreCheckpoint,
          activate: async (admission) => {
            const current = await host.get(sandbox.providerSandboxId, { signal: admission });
            if (current.state !== "stopped") throw Error("modal_resume_requires_retained_stop");
            const row = (
              await options.sql.query(
                `select s.id from public.sandboxes s join public.runtime_enrolments r on r.sandbox_id=s.id
          join public.credentials c on c.id=s.credential_id and c.version=s.credential_version
          where s.id=$1 and s.owner_id=$2 and s.lifecycle_generation=$3 and s.status='starting'
          and s.runtime_transport='dialout' and s.provider='modal' and s.activity_lease_id is not null
          and s.stop_requested_at is null and s.deleted_at is null and not s.application_secret_tainted
          and s.expires_at>now() and r.epoch=$4 and c.status='active' and (c.expires_at is null or c.expires_at>now())
          and exists(select 1 from public.members m where m.org_id=s.org_id and m.user_id=s.owner_id)`,
                [sandbox.id, caller.userId, sandbox.lifecycleGeneration, restoreCheckpoint.epoch],
              )
            ).rows[0];
            if (!row) throw Error("modal_resume_admission_changed");
            await host.resumeRuntime(
              {
                sandboxId: sandbox.providerSandboxId,
                ttlSeconds: Math.min(
                  PROVIDER_LIMITS.modal.maxTtlSeconds,
                  Math.max(1, Math.ceil((Date.parse(sandbox.expiresAt ?? "") - Date.now()) / 1000)) +
                    SANDBOX_STOP_MARGIN_SECONDS,
                ),
                checkpoint: { epoch: restoreCheckpoint.epoch, watermark: restoreCheckpoint.watermark },
              },
              admission,
            );
          },
        }),
      stop: () => host.stop({ sandboxId: sandbox.providerSandboxId }),
    };
  };
}
