import {
  type CredentialReader,
  type Provider,
  type ResumeStageObserver,
  SANDBOX_STOP_MARGIN_SECONDS,
  type SandboxInfo,
  type Sql,
} from "@armada/core/server";
import type { Caller } from "./caller.ts";
import { launchCredentials } from "./launch-credentials.ts";
import { recordLaunchStageQuietly } from "./launch-stage-record.ts";
import type { ModelAuthOwnership } from "./model-auth.ts";
import type { RuntimeLaunchPolicy } from "./runtime-launch.ts";
import type { RuntimeResumePlacement, RuntimeResumePrepare } from "./runtime-resume.ts";

type Sandbox = Parameters<RuntimeResumePrepare>[1];
type Checkpoint = Parameters<RuntimeResumePlacement["start"]>[1];
export interface RuntimeResumeOptions {
  sql: Sql;
  vault: CredentialReader;
  key: string;
  policy: RuntimeLaunchPolicy;
  modelAuth?: ModelAuthOwnership;
}

/** Common account/admission/lifetime policy; placements supply retained-compute checks and transport. */
export function runtimeResumePlacement<H extends Provider>(
  options: RuntimeResumeOptions,
  placement: {
    host(caller: Caller, sandbox: Sandbox): Promise<H>;
    retained(current: SandboxInfo): void;
    admissionError: string;
    binding?: readonly [provider: string, runtimeTransport: string];
    maxTtlSeconds: number;
    restore(
      host: H,
      sandbox: Sandbox,
      ttl: number,
      signal: AbortSignal,
      checkpoint: Checkpoint,
      observe: ResumeStageObserver,
    ): Promise<unknown>;
    verifyRestoredCoverage?(host: H, sandbox: Sandbox, signal: AbortSignal): Promise<void>;
    stop(host: H, sandbox: Sandbox): Promise<void>;
  },
): RuntimeResumePrepare {
  return async (caller, sandbox) => {
    const actor = { userId: caller.userId, orgId: sandbox.orgId, role: "member" as const };
    const credentials = await launchCredentials(options.vault, options.key, undefined, options.modelAuth).resolve(
      actor,
      sandbox.harness,
      sandbox.credentialId ?? undefined,
      sandbox.credentialVersion ?? undefined,
    );
    const host = await placement.host(caller, sandbox);
    const verifyRestoredCoverage = async (signal: AbortSignal, assertDispatch?: () => Promise<void>) => {
      if (!placement.verifyRestoredCoverage) return;
      await assertDispatch?.();
      signal.throwIfAborted();
      await placement.verifyRestoredCoverage(host, sandbox, signal);
    };
    return {
      start: (signal, restoreCheckpoint, confirmActivation, assertDispatch, ticketGuard) =>
        options.policy.start({
          host,
          actor,
          sandbox,
          credentials,
          signal,
          restoreCheckpoint,
          ...(assertDispatch ? { assertDispatch } : {}),
          ...(ticketGuard
            ? {
                ticketGuard,
                ...(placement.verifyRestoredCoverage
                  ? { activate: (admission: AbortSignal) => verifyRestoredCoverage(admission, assertDispatch) }
                  : {}),
              }
            : {
                activate: async (admission: AbortSignal) => {
                  placement.retained(await host.get(sandbox.providerSandboxId, { signal: admission }));
                  const identity = [sandbox.id, caller.userId, sandbox.lifecycleGeneration, restoreCheckpoint.epoch];
                  const row = (
                    await options.sql.query(
                      `select s.id from public.sandboxes s join public.runtime_enrolments r on r.sandbox_id=s.id
             join public.credentials c on c.id=s.credential_id and c.version=s.credential_version
             where s.id=$1 and s.owner_id=$2 and s.lifecycle_generation=$3 and s.status='starting'
             and s.activity_lease_id is not null and s.activity_until>clock_timestamp()
             and (s.reconcile_lease_until is null or s.reconcile_lease_until<=clock_timestamp())
             and s.stop_requested_at is null and s.deleted_at is null and not s.application_secret_tainted
             and s.expires_at>now() and r.epoch=$4 and c.status='active' and (c.expires_at is null or c.expires_at>now())
             and exists(select 1 from public.members m where m.user_id=s.owner_id and m.org_id=s.org_id)
             and ($5::text is null or s.provider::text=$5) and ($6::text is null or s.runtime_transport=$6)`,
                      [...identity, ...(placement.binding ?? [null, null])],
                    )
                  ).rows[0];
                  if (!row) throw Error(placement.admissionError);
                  const ttlSeconds = Math.min(
                    placement.maxTtlSeconds,
                    Math.max(1, Math.ceil((Date.parse(sandbox.expiresAt ?? "") - Date.now()) / 1000)) +
                      SANDBOX_STOP_MARGIN_SECONDS,
                  );
                  const observe: ResumeStageObserver = (stage) =>
                    recordLaunchStageQuietly(options.sql, sandbox.id, stage, sandbox.lifecycleGeneration);
                  await assertDispatch?.();
                  admission.throwIfAborted();
                  await placement.restore(host, sandbox, ttlSeconds, admission, restoreCheckpoint, observe);
                  await confirmActivation?.();
                  await verifyRestoredCoverage(admission, assertDispatch);
                  // The provider restored the machine; the runtime ticket is issued only after this.
                  await observe("machine_started");
                },
              }),
        }),
      stop: () => placement.stop(host, sandbox),
    };
  };
}
