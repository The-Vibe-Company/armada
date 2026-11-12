import {
  CLAUDE_ENDPOINT_ENV,
  CODEX_ENDPOINT_ENV,
  createModelEnvironmentCapture,
  createSqlVaultStore,
  decryptSecret,
  encryptSecret,
  type Harness,
  type ProviderRegistry,
  resolveCredentials,
  SANDBOX_STOP_MARGIN_SECONDS,
  sandboxActivity,
  sshRepointCredentials,
  VaultError,
} from "@armada/core/server";
import { installNativeCwdWrapper } from "@armada/provider-boat";
import type { Caller } from "./caller.ts";
import { createSqlData, type SandboxView } from "./data.ts";
import { launchCredentials } from "./launch-credentials.ts";
import type { ModelAuthOwnership } from "./model-auth.ts";
import { nativeState } from "./model-auth-state.ts";
import { pgArray } from "./sql.ts";

export interface CredentialRepointInput {
  id: string;
  credentialId: string;
  org?: string;
}
export interface CredentialRepointResult {
  id: string;
  credentialId: string;
  credentialVersion: number;
  harness: Harness;
  status: "bound";
  note: string;
}
export type CredentialRepoint = ReturnType<typeof createCredentialRepoint>;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EXPLICIT = "This sandbox now uses the selected account.";
const FALLBACK = "The pinned account was removed. This sandbox now uses your default account.";

/** Durable account selection precedes private delivery; no prompt may use a pending binding. */
export function createCredentialRepoint(
  sql: import("@armada/core/server").Sql,
  key: string | undefined,
  providers: ProviderRegistry,
  modelAuth: ModelAuthOwnership,
) {
  const data = createSqlData(sql),
    reader = createSqlVaultStore(sql),
    resolver = launchCredentials(reader, key, undefined, modelAuth);
  async function owned(caller: Caller, id: string, org?: string) {
    if (!UUID.test(id)) throw new VaultError("invalid", "Sandbox ID must be a UUID.");
    const found = await data(caller).sandboxes.get(id);
    if (!found || found.ownerId !== caller.userId || found.status === "deleted" || (org && org !== found.orgId))
      throw new VaultError("not_found", "Only the sandbox owner can change its account.");
    return found;
  }
  async function selected(caller: Caller, sandbox: SandboxView, id: string, version?: number) {
    return resolver.resolve(
      { userId: caller.userId, orgId: sandbox.orgId, role: "member" },
      sandbox.harness,
      id,
      version,
    );
  }
  async function remember(id: string, token: string, values: string[]) {
    await sql.transaction!(async (tx) => {
      const row = (
        await tx.query<{ redaction_enc: Uint8Array }>(
          `select m.redaction_enc from public.sandbox_model_credentials m join public.sandboxes s on s.id=m.sandbox_id where s.id=$1::uuid and s.activity_lease_id=$2::uuid and s.activity_until>now() and s.credential_delivery_pending for update of s,m`,
          [id, token],
        )
      ).rows[0];
      if (!row) throw new VaultError("conflict", "Account delivery admission changed. Retry.");
      const old = JSON.parse(await decryptSecret(new Uint8Array(row.redaction_enc), key)) as string[];
      const merged = [...new Set([...old, ...values])];
      if (Buffer.byteLength(JSON.stringify(merged)) > 4 * 1024 * 1024)
        throw new VaultError("unavailable", "Account redaction registry requires maintenance.");
      await tx.query("update sandbox_model_credentials set redaction_enc=$2 where sandbox_id=$1::uuid", [
        id,
        await encryptSecret(JSON.stringify(merged), key),
      ]);
    });
  }
  async function assertDelivery(
    caller: Caller,
    sandbox: SandboxView,
    pin: { credentialId: string; credentialVersion: number },
    token: string,
    tx = sql,
    lock = false,
  ) {
    if (lock) {
      await tx.query("select id from credentials where id=$1::uuid for update", [pin.credentialId]);
      await tx.query("select 1 from members where org_id=$1::uuid and user_id=$2::uuid for share", [
        sandbox.orgId,
        caller.userId,
      ]);
    }
    const permitted = await tx.query(
      `select s.id from public.sandboxes s join public.members member on member.org_id=s.org_id and member.user_id=s.owner_id
      join public.credentials c on c.id=s.credential_id and c.version=s.credential_version
      join public.sandbox_model_credentials material on material.sandbox_id=s.id and material.operation_id=$4::uuid
      where s.id=$1::uuid and s.owner_id=$2::uuid and s.org_id=$3::uuid and s.activity_lease_id=$4::uuid and s.activity_until>now() and s.credential_delivery_pending
      and s.credential_id=$5::uuid and s.credential_version=$6 and material.credential_id=s.credential_id and material.credential_version=s.credential_version
      and c.status='active' and (c.expires_at is null or c.expires_at>now())
      and ((c.scope='user' and c.owner_id=s.owner_id) or (c.scope='org' and c.owner_id=s.org_id))
      and ((s.harness='codex' and c.kind in ('openai','codex_auth')) or (s.harness='claude' and c.kind in ('anthropic','claude_oauth'))) ${lock ? "for update of s" : ""}`,
      [sandbox.id, caller.userId, sandbox.orgId, token, pin.credentialId, pin.credentialVersion],
    );
    if (!permitted.rows.length)
      throw new VaultError(
        "credential_refused",
        "Account authorization changed during delivery. Retry with an eligible current account.",
      );
  }
  async function change(
    caller: Caller,
    input: CredentialRepointInput,
    automatic = false,
    expectedVersion?: number,
  ): Promise<CredentialRepointResult> {
    if (!sql.transaction) throw new VaultError("unavailable", "Account changes require transactions.");
    if (!UUID.test(input.credentialId)) throw new VaultError("invalid", "Account ID must be a UUID.");
    let found = await owned(caller, input.id, input.org);
    const material = await selected(caller, found, input.credentialId, expectedVersion),
      pin = material.binding;
    if (!pin) throw new VaultError("unavailable", "The selected account has no stable revision.");
    if (material.codexAuthJson && material.env.ARMADA_SERVER_CODEX !== "1")
      nativeState(material.env.ARMADA_CODEX_AUTH_JSON ?? "");
    const actor = { userId: caller.userId, orgId: found.orgId, role: "member" as const };
    const provider = await providers.resolve(found, { userId: caller.userId });
    // Re-pointing has exactly the launch provider policy; no provider side effect
    // or durable admission may precede this eligibility check.
    if (material.env[CLAUDE_ENDPOINT_ENV] && provider.id !== "modal")
      throw new VaultError("invalid", "Custom Claude gateways currently require Modal.");
    if (material.env[CODEX_ENDPOINT_ENV] && provider.id !== "modal")
      throw new VaultError("invalid", "Custom Codex endpoints currently require Modal.");
    const environmentCapture = provider.id === "boat" ? createModelEnvironmentCapture() : undefined;
    const store = data(caller).sandboxes,
      token = crypto.randomUUID();
    if (found.stopRequestedAt && found.status !== "stopped" && !found.credentialDeliveryPending)
      throw new VaultError("conflict", "A stop is already pending. Finish the safe Stop before changing accounts.");
    const introducedStop = !found.stopRequestedAt;
    let destructive = false;
    await sql.transaction!(async (tx) => {
      // Share the exec admission row lock before advancing either stop fence.
      // A refused account change must not invalidate an existing command.
      await tx.query("select id from public.sandboxes where id=$1::uuid for update", [found.id]);
      const active = await tx.query(
        "select id from public.sandbox_exec_admissions where sandbox_id=$1::uuid and active and expires_at>now() limit 1",
        [found.id],
      );
      if (active.rows.length)
        throw new VaultError("conflict", "An admitted command is still active. Wait for it before changing accounts.");
      await createSqlData(tx)(caller).sandboxes.update(found.id, {
        stopRequested: true,
        advanceGeneration: true,
        activityToken: token,
        ...(found.lifecycleGeneration === undefined ? {} : { expectedGeneration: found.lifecycleGeneration }),
      });
    });
    found = {
      ...found,
      ...(found.lifecycleGeneration === undefined ? {} : { lifecycleGeneration: found.lifecycleGeneration + 1 }),
    };
    const same =
      found.credentialDeliveryPending &&
      (
        await sql.query(
          "select 1 from sandbox_model_credentials where sandbox_id=$1::uuid and credential_id=$2::uuid and credential_version=$3",
          [found.id, pin.credentialId, pin.credentialVersion],
        )
      ).rows.length > 0;
    return sandboxActivity(
      store,
      found,
      {},
      async (signal) => {
        try {
          if (!same) {
            const sampledSecrets: string[] = [];
            const machine = await provider.get(found.providerSandboxId, { signal });
            if (
              machine.state === "stopped" &&
              (
                await sql.query(
                  "select id from sandbox_exec_admissions where sandbox_id=$1::uuid and active and expires_at>now() limit 1",
                  [found.id],
                )
              ).rows.length
            )
              throw new VaultError(
                "conflict",
                "A command call is still active. Wait for it to settle before changing accounts.",
              );
            if (machine.state !== "stopped") {
              const outstanding = await sql.query(
                "select id from sandbox_exec_admissions where sandbox_id=$1::uuid limit 1",
                [found.id],
              );
              if (outstanding.rows.length)
                throw new VaultError(
                  "conflict",
                  "An admitted command has not settled. Wait for it, or use a safe Stop before changing accounts.",
                );
              if (!provider.hasActiveTurns || (await provider.hasActiveTurns(found.providerSandboxId)))
                throw new VaultError(
                  "conflict",
                  "Native work is active or cannot be proven idle. Stop the sandbox safely before changing its account.",
                );
              if (provider.id === "boat") {
                const sampled = await provider.exec({
                  sandboxId: found.providerSandboxId,
                  command: environmentCapture!.command,
                  timeoutSeconds: 45,
                  signal,
                });
                if (sampled.detached || sampled.timedOut || sampled.exitCode !== 0)
                  throw new VaultError("unavailable", "Private account redaction capture failed before stopping.");
                signal.throwIfAborted();
                sampledSecrets.push(
                  ...environmentCapture!.decrypt(
                    await sshRepointCredentials(provider, found.providerSandboxId, {
                      harness: found.harness,
                      env: {},
                      phase: "sample",
                      revision: String(found.lifecycleGeneration ?? 1),
                      credentialId: pin.credentialId,
                      credentialVersion: pin.credentialVersion,
                      sandboxId: found.id,
                    }),
                  ),
                );
                signal.throwIfAborted();
              }
              // Use the ordinary Stop preservation receipt before any destructive transition.
              // A failure note is not a successful receipt; leave the workspace running.
              await store.update(found.id, {
                stopRequested: true,
                renewActivity: true,
                ...(found.lifecycleGeneration === undefined ? {} : { expectedGeneration: found.lifecycleGeneration }),
                activityToken: token,
              });
              if (
                !store.preserveWork ||
                (await store.preserveWork(found.id, provider, found.providerSandboxId)) === "pending"
              )
                throw new VaultError(
                  "conflict",
                  "Work preservation is incomplete. Retry the account change after a safe Stop.",
                );
              signal.throwIfAborted();
              const receipt = await sql.query(
                `select id from sandboxes where id=$1::uuid and activity_lease_id=$2::uuid and activity_until>now()
               and stop_requested_at is not null and preservation_stop_generation=stop_generation and not application_secret_tainted`,
                [found.id, token],
              );
              if (!receipt.rows.length)
                throw new VaultError(
                  "conflict",
                  "Work could not be safely preserved. Stop the sandbox safely before changing its account.",
                );
              destructive = true;
              await provider.stop({ sandboxId: found.providerSandboxId });
              signal.throwIfAborted();
            }
            const stopped = await provider.get(found.providerSandboxId, { signal });
            if (
              stopped.id !== found.providerSandboxId ||
              stopped.state !== "stopped" ||
              stopped.stopNote === "checkpoint_failed_disk_not_retained"
            )
              throw new VaultError(
                "credential_binding_unsafe",
                "Physical stop is not confirmed. The existing binding was retained.",
              );
            const previousOwners = await sql.query<{ account_id: string }>(
              "select account_id from model_auth_ownership where sandbox_id=$1::uuid",
              [found.id],
            );
            const ids = [
              ...new Set([
                pin.credentialId,
                ...(found.credentialId ? [found.credentialId] : []),
                ...previousOwners.rows.map((x) => x.account_id),
              ]),
            ].sort();
            await sql.transaction!(async (tx) => {
              await tx.query("select id from public.credentials where id=any($1::uuid[]) order by id for update", [
                pgArray(ids),
              ]);
              const current = (
                await tx.query<{ version: number; status: string; expires_at: string | null }>(
                  "select version,status,expires_at from credentials where id=$1::uuid",
                  [pin.credentialId],
                )
              ).rows[0];
              if (
                !current ||
                current.version !== pin.credentialVersion ||
                current.status !== "active" ||
                (current.expires_at && new Date(current.expires_at).getTime() <= Date.now())
              )
                throw new VaultError("credential_refused", "The selected account changed. Choose it again.");
              const check = await tx.query(
                `select s.id from public.sandboxes s join public.members m on m.org_id=s.org_id and m.user_id=s.owner_id where s.id=$1::uuid and s.owner_id=$2::uuid and s.activity_lease_id=$3::uuid and s.activity_until>now() for update of s`,
                [found.id, caller.userId, token],
              );
              if (!check.rows.length) throw new VaultError("conflict", "Sandbox admission changed. Retry.");
              const retained = await tx.query<{ state_enc: Uint8Array }>(
                "select a.state_enc from model_auth_state a join model_auth_ownership o on o.account_id=a.account_id and o.account_version=a.account_version where o.sandbox_id=$1::uuid",
                [found.id],
              );
              const previous = (
                await tx.query<{ redaction_enc: Uint8Array }>(
                  "select redaction_enc from sandbox_model_credentials where sandbox_id=$1::uuid for update",
                  [found.id],
                )
              ).rows[0];
              const secrets: string[] = previous
                ? JSON.parse(await decryptSecret(new Uint8Array(previous.redaction_enc), key))
                : [];
              for (const old of retained.rows)
                secrets.push(
                  ...(JSON.parse(await decryptSecret(new Uint8Array(old.state_enc), key)) as { secrets: string[] })
                    .secrets,
                );
              secrets.push(...sampledSecrets, ...material.secrets);
              await tx.query(
                "delete from sandbox_exec_admissions where sandbox_id=$1::uuid and (not active or expires_at<=now())",
                [found.id],
              );
              await tx.query("delete from model_auth_ownership where sandbox_id=$1::uuid", [found.id]);
              await tx.query(
                "update public.sandboxes set credential_id=null,credential_version=null,credential_delivery_pending=true,status='stopped',stopped_at=now(),status_reason=null,stop_requested_at=null,credential_note=$2 where id=$1::uuid",
                [found.id, "Account delivery is pending. Retry the account change before sending a prompt."],
              );
              await tx.query(
                `insert into sandbox_model_credentials(sandbox_id,operation_id,credential_id,credential_version,configuration_enc,redaction_enc,quota_history_mixed) values($1::uuid,$2::uuid,$3::uuid,$4,$5,$6,$7) on conflict(sandbox_id) do update set operation_id=excluded.operation_id,credential_id=excluded.credential_id,credential_version=excluded.credential_version,configuration_enc=excluded.configuration_enc,redaction_enc=excluded.redaction_enc,quota_history_mixed=sandbox_model_credentials.quota_history_mixed or excluded.quota_history_mixed`,
                [
                  found.id,
                  token,
                  pin.credentialId,
                  pin.credentialVersion,
                  await encryptSecret(
                    JSON.stringify({
                      automatic,
                      previousCredentialId: found.credentialId,
                      previousVersion: found.credentialVersion,
                    }),
                    key,
                  ),
                  await encryptSecret(JSON.stringify([...new Set(secrets)]), key),
                  found.credentialId !== pin.credentialId || found.credentialVersion !== pin.credentialVersion,
                ],
              );
            });
          } else
            await sql.query("update sandbox_model_credentials set operation_id=$2::uuid where sandbox_id=$1::uuid", [
              found.id,
              token,
            ]);
          signal.throwIfAborted();
          // Standard launch admission supports legacy native ownership and server-owned refresh without a nested transaction.
          const current = await selected(caller, found, pin.credentialId, pin.credentialVersion);
          await resolver.admit?.(actor, current, found.id);
          signal.throwIfAborted();
          await sql.transaction!(async (tx) => {
            const lock = await tx.query(
              "select id from public.sandboxes where id=$1::uuid and activity_lease_id=$2::uuid and activity_until>now() and credential_delivery_pending for update",
              [found.id, token],
            );
            if (!lock.rows.length) throw new VaultError("conflict", "Account delivery admission changed. Retry.");
            await resolveCredentials(createSqlVaultStore(tx), key, {
              ...actor,
              harness: found.harness,
              credentialId: pin.credentialId,
              credentialVersion: pin.credentialVersion,
            });
            if (found.provider === "modal") {
              const rows = await tx.query<{
                scope: string;
                owner_id: string;
                credential_id: string | null;
                credential_version: number | null;
                record: import("@armada/provider-modal").Machine;
              }>(
                `select m.scope,m.owner_id,m.record,h.credential_id,h.credential_version from public.modal_machines m join modal_server_harnesses h on h.scope=m.scope and h.machine_id=m.id join modal_server_scopes c on c.scope=m.scope where m.id=$1 and m.org_id=$2::uuid and h.harness=$3 and c.context->'binding'->>'workspace'=$4 and c.context->'binding'->>'environment'=$5 and c.context->'binding'->>'appId'=$6 and (m.lease_until is null or m.lease_until<now()) for update of m,h`,
                [
                  found.providerSandboxId,
                  found.orgId,
                  found.harness,
                  found.modal?.workspace,
                  found.modal?.environment,
                  found.modal?.appId,
                ],
              );
              if (
                rows.rows.length !== 1 ||
                !rows.rows[0] ||
                rows.rows[0].record.golden ||
                !rows.rows[0].record.recoveryImageId
              )
                throw new VaultError(
                  "credential_binding_unsafe",
                  "The retained native policy is not stopped or is busy.",
                );
              const row = rows.rows[0];
              if ((row.record.launchUserId ?? row.owner_id) !== caller.userId)
                throw new VaultError("forbidden", "Only the original workspace owner can change its account.");
              const matching =
                row.credential_id === pin.credentialId &&
                row.credential_version === pin.credentialVersion &&
                row.record.info.labels.credentialId === pin.credentialId &&
                row.record.info.labels.credentialVersion === String(pin.credentialVersion);
              if (row.record.phase === "stopped") {
                row.record.info.labels = {
                  ...row.record.info.labels,
                  credentialId: pin.credentialId,
                  credentialVersion: String(pin.credentialVersion),
                  credentialRepoint: token,
                };
                await tx.query(
                  "update modal_server_harnesses set credential_id=$3::uuid,credential_version=$4 where scope=$1 and machine_id=$2",
                  [row.scope, found.providerSandboxId, pin.credentialId, pin.credentialVersion],
                );
                await tx.query("update modal_machines set record=$3::jsonb where scope=$1 and id=$2", [
                  row.scope,
                  found.providerSandboxId,
                  JSON.stringify(row.record),
                ]);
              } else if (
                !same ||
                found.credentialId !== pin.credentialId ||
                found.credentialVersion !== pin.credentialVersion ||
                !matching
              ) {
                throw new VaultError(
                  "credential_binding_unsafe",
                  "Only an already-matching pending native policy can finish delivery on active compute.",
                );
              }
            }
            await tx.query(
              "update public.sandboxes set credential_id=$2::uuid,credential_version=$3 where id=$1::uuid",
              [found.id, pin.credentialId, pin.credentialVersion],
            );
          });
          await assertDelivery(caller, found, pin, token);
          await sql.query(
            "update sandboxes set status='starting',stopped_at=null,status_reason=null where id=$1::uuid and activity_lease_id=$2::uuid and credential_delivery_pending and status<>'starting'",
            [found.id, token],
          );
          if (provider.id === "boat") {
            const warm = await provider.exec({
              sandboxId: found.providerSandboxId,
              command: environmentCapture!.command,
              timeoutSeconds: 45,
              signal,
            });
            if (warm.detached || warm.timedOut || warm.exitCode !== 0)
              throw new VaultError(
                "unavailable",
                "Private native account preparation failed. Retry the account change.",
              );
            signal.throwIfAborted();
            await assertDelivery(caller, found, pin, token);
            await remember(
              found.id,
              token,
              environmentCapture!.decrypt(
                await sshRepointCredentials(provider, found.providerSandboxId, {
                  harness: found.harness,
                  env: {},
                  phase: "capture",
                  credentialId: pin.credentialId,
                  credentialVersion: pin.credentialVersion,
                  sandboxId: found.id,
                  revision: String(found.lifecycleGeneration ?? 1),
                }),
              ),
            );
            signal.throwIfAborted();
            await assertDelivery(caller, found, pin, token);
            await installNativeCwdWrapper(
              async (request) => {
                const result = await provider.exec({ ...request, signal });
                if (result.detached || result.timedOut || result.exitCode !== 0)
                  throw Error("Native account wrapper installation failed.");
              },
              found.providerSandboxId,
              found.harness,
            );
            signal.throwIfAborted();
            await assertDelivery(caller, found, pin, token);
            const native = current.codexAuthJson
              ? await resolver.hydrateNative?.(
                  actor,
                  current,
                  found.id,
                  provider,
                  found.providerSandboxId,
                  found.lifecycleGeneration,
                )
              : false;
            if (current.codexAuthJson && !native)
              throw new VaultError("unavailable", "Native account hydration is unavailable.");
            signal.throwIfAborted();
            const env = Object.fromEntries(
              Object.entries(current.env).filter(([name]) =>
                ["OPENAI_API_KEY", "ARMADA_CODEX_ENDPOINT", "ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"].includes(
                  name,
                ),
              ),
            );
            await assertDelivery(caller, found, pin, token);
            await sshRepointCredentials(provider, found.providerSandboxId, {
              harness: found.harness,
              env,
              phase: "install",
              ...(current.codexAuthJson
                ? {
                    nativeAccountId: JSON.parse(current.env.ARMADA_CODEX_AUTH_JSON ?? "{}").tokens
                      ?.account_id as string,
                  }
                : {}),
              credentialId: pin.credentialId,
              credentialVersion: pin.credentialVersion,
              sandboxId: found.id,
              native: native === true,
              nativeMode: current.env.ARMADA_SERVER_CODEX === "1" ? "broker" : current.codexAuthJson ? "file" : "none",
              revision: String(found.lifecycleGeneration ?? 1),
            });
            signal.throwIfAborted();
          } else {
            const warm = await provider.exec({
              sandboxId: found.providerSandboxId,
              command: "true",
              timeoutSeconds: 45,
              signal,
            });
            if (warm.detached || warm.timedOut || warm.exitCode !== 0)
              throw new VaultError(
                "unavailable",
                "Retained native account bootstrap failed. Retry the account change.",
              );
            signal.throwIfAborted();
          }
          const observed = await provider.get(found.providerSandboxId, { signal });
          if (observed.id !== found.providerSandboxId || !["ready", "running"].includes(observed.state))
            throw new VaultError("unavailable", "Native account delivery did not leave ready compute. Retry.");
          if (observed.expiresAt && observed.expiresAt.getTime() <= Date.now() + SANDBOX_STOP_MARGIN_SECONDS * 1000)
            throw new VaultError(
              "conflict",
              "The restored machine has no remaining lifetime headroom. Extend it before retrying account delivery.",
            );
          const completed = await sql.transaction!(async (tx) => {
            await assertDelivery(caller, found, pin, token, tx, true);
            return tx.query(
              `update public.sandboxes s set credential_delivery_pending=false,credential_note=$3,expires_at=case when $4::timestamptz is null then clock_timestamp()+s.effective_ttl_seconds*interval '1 second' else least(clock_timestamp()+s.effective_ttl_seconds*interval '1 second',$4::timestamptz-$5::double precision*interval '1 second') end from sandbox_model_credentials m where s.id=$1::uuid and m.sandbox_id=s.id and m.operation_id=$2::uuid and s.activity_lease_id=$2::uuid and s.activity_until>now() and s.credential_id=m.credential_id and s.credential_version=m.credential_version returning s.id`,
              [
                found.id,
                token,
                automatic ? FALLBACK : EXPLICIT,
                observed.expiresAt?.toISOString() ?? null,
                SANDBOX_STOP_MARGIN_SECONDS,
              ],
            );
          });
          if (!completed.rows.length)
            throw new VaultError("conflict", "Account delivery admission changed before acknowledgment. Retry.");
          return {
            result: {
              id: found.id,
              ...pin,
              harness: found.harness,
              status: "bound" as const,
              note: automatic ? FALLBACK : EXPLICIT,
            },
            patch: { status: "ready" as const, stoppedAt: null, stopRequested: false },
          };
        } catch (error) {
          if (introducedStop && !destructive)
            await sql.query(
              "update sandboxes set stop_requested_at=null where id=$1::uuid and activity_lease_id=$2::uuid and lifecycle_generation=$3 and activity_until>now() and not credential_delivery_pending",
              [found.id, token, found.lifecycleGeneration],
            );
          throw error;
        }
      },
      { initialLeaseId: token, deadlineMs: 10 * 60_000 },
    );
  }
  return {
    repoint: (caller: Caller, input: CredentialRepointInput) => change(caller, input),
    async fallback(caller: Caller, id: string): Promise<CredentialRepointResult | null> {
      const found = await owned(caller, id);
      if (found.credentialDeliveryPending) {
        const pending = (
          await sql.query<{ credential_id: string; credential_version: number; configuration_enc: Uint8Array }>(
            "select credential_id,credential_version,configuration_enc from sandbox_model_credentials where sandbox_id=$1::uuid",
            [id],
          )
        ).rows[0];
        if (!pending) throw new VaultError("unavailable", "The pending account change cannot be identified.");
        const intent = JSON.parse(await decryptSecret(new Uint8Array(pending.configuration_enc), key)) as {
          automatic?: boolean;
        };
        return change(
          caller,
          { id, credentialId: pending.credential_id },
          intent.automatic === true,
          pending.credential_version,
        );
      }
      if (!found.credentialId) return null;
      const old = (
        await sql.query<{ status: string }>("select status from credentials where id=$1::uuid", [found.credentialId])
      ).rows[0];
      if (old && old.status !== "deleted") return null;
      const kinds = found.harness === "codex" ? ["openai", "codex_auth"] : ["anthropic", "claude_oauth"];
      const chosen = await sql.query<{ id: string }>(
        `select id from credentials where scope='user' and owner_id=$1::uuid and is_default and status='active' and kind=any($2::public.credential_kind[]) and (expires_at is null or expires_at>now())`,
        [caller.userId, pgArray(kinds)],
      );
      return chosen.rows.length === 1 && chosen.rows[0]
        ? change(caller, { id, credentialId: chosen.rows[0].id }, true)
        : null;
    },
  };
}
