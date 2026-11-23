import { createHash, randomUUID } from "node:crypto";
import { decryptSecret, encryptSecret } from "./crypto.ts";
import type { GoldenActor } from "./golden.ts";
import { assertGoldenMutation } from "./golden.ts";
import type { GoldenBuildStatus } from "./golden-build-status.ts";
import type { GoldenBuildWarning } from "./golden-build-warning.ts";
import { GOLDEN_SSH_RECEIPT_PHASES, GoldenError, parseGoldenName } from "./golden-config.ts";
import {
  authorizeGoldenRepositories,
  createGoldenCreateService,
  type GoldenCreateOptions,
  reserveGoldenBuild,
  sqlGoldenBackendSlots,
} from "./golden-create.ts";
import type { GoldenCreateService } from "./golden-create-service.ts";
import type { Sql } from "./golden-store.ts";
import { type Provider, ProviderError } from "./provider.ts";
import {
  assertProviderOf,
  HOST_CAPABILITIES,
  isSandboxProvider,
  type ModalBinding,
  PROVIDER_LIMITS,
  type ProviderTarget,
  type SandboxProviderId,
} from "./sandbox-provider.ts";

type Input = Parameters<GoldenCreateService["create"]>[2];

export type { GoldenBuildStatus } from "./golden-build-status.ts";

interface Job {
  id: string;
  name: string;
  org_id: string;
  owner_id: string;
  visibility: "org" | "private";
  state: GoldenBuildStatus["state"];
  phase: string;
  error_code: "build_failed" | null;
  request_hash: string;
  provider: SandboxProviderId;
  reservation_id: string | null;
  payload_enc: Uint8Array<ArrayBuffer>;
  fence: string | null;
  builder_id: string | null;
  golden_id: string | null;
  snapshot: string | null;
  build_warnings: GoldenBuildWarning[];
  failure_reason: string | null;
}
type FailureReason =
  | "skillpack_integrity_failed"
  | "provider_payment_required"
  | "provider_snapshot_rejected"
  | `detail:${string}`;

const INTERRUPTED_BUILD: FailureReason =
  "detail:Build execution was interrupted before recording an outcome. Ask an administrator to inspect the build.";
const FAILED_BUILD: FailureReason =
  "detail:The operation did not complete. Ask an administrator to inspect this build's status before retrying.";

function receiptFailureReason(error: unknown, phase: string, safeToRelease: boolean) {
  if (error instanceof GoldenError) {
    if (error.safeReason) return error.safeReason;
    if (error.safeMessage) return `detail:${error.safeMessage.slice(0, 1017)}` satisfies FailureReason;
  }
  if (safeToRelease && error instanceof ProviderError) {
    if (error.code === "payment_required") return "provider_payment_required";
    if (error.code === "invalid_request" && error.status === 400 && phase === "snapshot")
      return "provider_snapshot_rejected";
  }
  return FAILED_BUILD;
}

export interface GoldenBuildJobsOptions {
  sql: Sql;
  encryptionKey: string | undefined;
  service: Omit<GoldenCreateOptions, "sql" | "job">;
  /** Resolves current credentials against the persisted immutable target. Must verify Modal App/environment without allocating a VM. */
  provider(actor: GoldenActor, visibility: "org" | "private", target: ProviderTarget): Promise<Provider>;
}
/** Durable queue. No task is owned by an HTTP connection and expired work is never replayed. */
export class GoldenBuildJobs {
  constructor(private readonly options: GoldenBuildJobsOptions) {}

  private transaction<T>(work: (sql: Sql) => Promise<T>): Promise<T> {
    if (!this.options.sql.transaction) throw new GoldenError("conflict", "Durable build transactions unavailable.");
    return this.options.sql.transaction(work);
  }
  private async actor(
    sql: Sql,
    job: { owner_id: string; org_id: string; visibility: "org" | "private"; golden_id?: string | null },
  ): Promise<GoldenActor> {
    const row = (
      await sql.query<{ role: "admin" | "member" }>(
        "select role from public.members where org_id=$1 and user_id=$2 for share",
        [job.org_id, job.owner_id],
      )
    ).rows[0];
    if (!row || (job.visibility === "org" && row.role !== "admin"))
      throw new GoldenError("forbidden", "You cannot build this golden.");
    const actor = { userId: job.owner_id, orgId: job.org_id, role: row.role };
    if (job.golden_id) {
      const target = (
        await sql.query<{ org_id: string; owner_id: string; visibility: "org" | "private" }>(
          "select org_id,owner_id,visibility from public.goldens where id=$1 for share",
          [job.golden_id],
        )
      ).rows[0];
      if (!target || target.org_id !== job.org_id || target.visibility !== job.visibility)
        throw new GoldenError("forbidden", "Build target authorization changed.");
      assertGoldenMutation(actor, {
        orgId: target.org_id,
        ownerId: target.owner_id,
        visibility: target.visibility,
        name: "",
      });
    }
    return actor;
  }
  async admit(
    provider: Provider,
    actor: GoldenActor,
    input: Input,
    idempotencyKey: string,
    additions?: readonly string[],
  ): Promise<GoldenBuildStatus> {
    if (!/^[A-Za-z0-9_-]{16,128}$/.test(idempotencyKey))
      throw new GoldenError(
        "invalid_config",
        "Use an idempotencyKey of 16–128 letters, digits, underscores or hyphens.",
      );
    parseGoldenName(input.name);
    if (input.existingGolden) assertGoldenMutation(actor, input.existingGolden);
    else
      assertGoldenMutation(actor, {
        orgId: actor.orgId,
        ownerId: actor.userId,
        visibility: input.visibility,
        name: input.name,
      });
    if (!isSandboxProvider(provider.id)) throw new GoldenError("invalid_config", "Unknown golden provider.");
    const providerId = provider.id;
    const target = buildTarget(providerId, actor.orgId, input);
    if (input.existingGolden) assertProviderOf(provider, input.existingGolden.provider);
    if (
      (input.config?.repos.length ?? input.repos.length) < 1 ||
      (input.config?.repos.length ?? input.repos.length) > 16
    )
      throw new GoldenError("invalid_config", "A golden needs 1 to 16 repositories.");
    // Fixed field order, including all execution-affecting input. Credentials never enter payload.
    const payload = JSON.stringify({
      name: input.name,
      visibility: input.visibility,
      repos: input.repos,
      config: input.config ?? null,
      setup: input.setup ?? null,
      existingGolden: input.existingGolden ?? null,
      provider: providerId,
      modal: target.modal,
    });
    // An additive retry can see the resolved branches published by its first run.
    // Bind new requests to their original input, independent of the new snapshot revision.
    const request = {
      name: input.name,
      visibility: input.visibility,
      repos: input.repos,
      config: input.config ?? null,
      setup: input.setup ?? null,
      goldenId: input.existingGolden?.id ?? null,
      ...(target.modal ? { provider: providerId, modal: target.modal } : {}),
    };
    const hashRequest = (payload: object) => createHash("sha256").update(JSON.stringify(payload)).digest("hex");
    const hash = additions
      ? hashRequest({ ...request, config: null, additions })
      : hashRequest({ ...request, ...(input.config ? { resolveDefaultBranch: true } : {}) });
    // Old clients and servers normalized omission to main before hashing.
    const legacyHash = input.config
      ? hashRequest({
          ...request,
          config: {
            ...input.config,
            repos: input.config.repos.map((repo) => ({ ...repo, branch: repo.branch ?? "main" })),
          },
        })
      : hash;
    // Recover an existing admission before asking GitHub again. Authorization can rotate
    // OAuth credentials, so it must run outside the reservation transaction: rollback
    // must never restore a refresh token already consumed upstream.
    const priorAdmission = await this.transaction(async (sql) => {
      await this.actor(sql, {
        owner_id: actor.userId,
        org_id: actor.orgId,
        visibility: input.visibility,
        ...(input.existingGolden ? { golden_id: input.existingGolden.id } : {}),
      });
      return (
        await sql.query<Job>(
          "select * from public.golden_build_jobs where owner_id=$1 and org_id=$2 and idempotency_key=$3",
          [actor.userId, actor.orgId, idempotencyKey],
        )
      ).rows[0];
    });
    if (priorAdmission) {
      if (
        (priorAdmission.request_hash !== hash && priorAdmission.request_hash !== legacyHash) ||
        priorAdmission.provider !== providerId
      )
        throw new GoldenError("conflict", "Idempotency key was used for a different build.");
      return this.dto(priorAdmission, input.name);
    }
    await authorizeGoldenRepositories(
      { ...this.options.service, sql: this.options.sql },
      actor,
      input.visibility,
      input.config ? input.config.repos.map(({ owner, repo }) => `${owner}/${repo}`) : input.repos,
    );
    const encrypted = await encryptSecret(payload, this.options.encryptionKey);
    const job = await this.transaction(async (sql) => {
      const currentActor = await this.actor(sql, {
        owner_id: actor.userId,
        org_id: actor.orgId,
        visibility: input.visibility,
        ...(input.existingGolden ? { golden_id: input.existingGolden.id } : {}),
      });
      // Serializes duplicate admissions even before a capacity slot exists.
      await sql.query("select pg_advisory_xact_lock(hashtextextended($1,0))", [
        actor.userId + ":" + actor.orgId + ":" + idempotencyKey,
      ]);
      const prior = (
        await sql.query<Job>(
          "select * from public.golden_build_jobs where owner_id=$1 and org_id=$2 and idempotency_key=$3",
          [actor.userId, actor.orgId, idempotencyKey],
        )
      ).rows[0];
      if (prior) {
        if ((prior.request_hash !== hash && prior.request_hash !== legacyHash) || prior.provider !== providerId)
          throw new GoldenError("conflict", "Idempotency key was used for a different build.");
        return prior;
      }
      if (input.existingGolden) {
        const current = (
          await sql.query<{
            provider_snapshot_id: string | null;
            owner_id: string;
            visibility: string;
            provider: string;
            modal_workspace: string | null;
            modal_environment: string | null;
            modal_app_id: string | null;
          }>(
            "select provider_snapshot_id,owner_id,visibility,provider,modal_workspace,modal_environment,modal_app_id from public.goldens where id=$1 and org_id=$2 for update",
            [input.existingGolden.id, actor.orgId],
          )
        ).rows[0];
        if (
          !current ||
          current.provider_snapshot_id !== input.existingGolden.providerSnapshotId ||
          current.owner_id !== input.existingGolden.ownerId ||
          current.visibility !== input.visibility ||
          current.provider !== providerId ||
          (target.modal &&
            (current.modal_workspace !== target.modal.workspace ||
              current.modal_environment !== target.modal.environment ||
              current.modal_app_id !== target.modal.appId))
        )
          throw new GoldenError("conflict", "Golden changed before build admission.");
      }
      // The server factory verifies the pinned management connection, never a client profile label.
      // It may read App metadata here, but must not allocate a builder before this transaction commits.
      const verified = HOST_CAPABILITIES[providerId].revalidateGoldenManagementAtAdmission
        ? await this.options.provider(currentActor, input.visibility, target)
        : provider;
      assertProviderOf(verified, providerId);
      const reservation = await reserveGoldenBuild(sql, verified, currentActor, input.existingGolden);
      if (!reservation && PROVIDER_LIMITS[providerId].defaultGoldenCapacity !== undefined)
        throw new GoldenError("conflict", "Boat durable builds require a capacity reservation.");
      const id = randomUUID();
      return (
        await sql.query<Job>(
          "insert into public.golden_build_jobs(id,org_id,owner_id,visibility,idempotency_key,request_hash,payload_enc,reservation_id,name,golden_id,provider,expected_snapshot_id,revision_known) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,true) returning *",
          [
            id,
            actor.orgId,
            actor.userId,
            input.visibility,
            idempotencyKey,
            hash,
            encrypted,
            reservation ?? null,
            input.name,
            input.existingGolden?.id ?? null,
            providerId,
            input.existingGolden?.providerSnapshotId ?? null,
          ],
        )
      ).rows[0]!;
    });
    return this.dto(job, input.name);
  }
  async status(
    userId: string,
    id: string,
    orgId?: string,
    idempotencyKey?: string,
    allowedOrgs?: readonly string[],
  ): Promise<GoldenBuildStatus> {
    if (!idempotencyKey && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id))
      throw new GoldenError("not_found", "No such build.");
    const job = (
      await this.options.sql.query<Job>(
        "select j.* from public.golden_build_jobs j join public.members m on m.org_id=j.org_id and m.user_id=$1 where (j.visibility='org' or j.owner_id=$1) and (j.golden_id is null or exists(select 1 from public.goldens g where g.id=j.golden_id and (g.visibility='org' or g.owner_id=$1))) and " +
          (idempotencyKey ? "j.owner_id=$1 and j.org_id=$2 and j.idempotency_key=$3" : "j.id=$2 and $3::text is null") +
          " and ($4::uuid[] is null or j.org_id=any($4::uuid[]))",
        idempotencyKey
          ? [userId, orgId, idempotencyKey, allowedOrgs ? "{" + allowedOrgs.join(",") + "}" : null]
          : [userId, id, null, allowedOrgs ? "{" + allowedOrgs.join(",") + "}" : null],
      )
    ).rows[0];
    if (!job) throw new GoldenError("not_found", "No such build.");
    // Do not decrypt payload for status: even service-side readers need no arbitrary setup text.
    return this.dto(job);
  }
  /** Latest visible active attempt for a stored golden; absence is not proof that capacity is free. */
  async findActive(
    userId: string,
    goldenId: string,
    allowedOrgs: readonly string[],
  ): Promise<GoldenBuildStatus | null> {
    const job = (
      await this.options.sql.query<Job>(
        `select j.* from public.golden_build_jobs j
       join public.members m on m.org_id=j.org_id and m.user_id=$1
       where j.golden_id=$2 and j.org_id=any($3::uuid[])
         and (j.visibility='org' or j.owner_id=$1)
         and exists(select 1 from public.goldens g where g.id=j.golden_id and (g.visibility='org' or g.owner_id=$1))
         and j.state in ('queued','running','recovery_required')
       order by j.created_at desc,j.id desc limit 1`,
        [userId, goldenId, "{" + allowedOrgs.join(",") + "}"],
      )
    ).rows[0];
    return job ? this.dto(job) : null;
  }

  /** Only the requesting owner may cancel work that has provably never started.
   * Locking the same row as runOne makes cancellation and worker admission exclusive.
   */
  async cancel(userId: string, id: string, allowedOrgs: readonly string[]): Promise<GoldenBuildStatus> {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id))
      throw new GoldenError("not_found", "No such build.");
    return this.transaction(async (sql) => {
      const job = (
        await sql.query<Job>(
          `select j.* from public.golden_build_jobs j
           join public.members m on m.org_id=j.org_id and m.user_id=$1
           where j.id=$2 and j.owner_id=$1 and j.org_id=any($3::uuid[])
             and (j.golden_id is null or exists(
               select 1 from public.goldens g where g.id=j.golden_id and (g.visibility='org' or g.owner_id=$1)))
           for update of j`,
          [userId, id, "{" + allowedOrgs.join(",") + "}"],
        )
      ).rows[0];
      if (!job) throw new GoldenError("not_found", "No such build.");
      const reason =
        "detail:Build cancelled by its owner before a builder started. Start a new build request when ready.";
      if (job.state === "failed" && job.failure_reason === reason) return this.dto(job);
      if (
        job.state !== "queued" ||
        job.phase !== "queued" ||
        job.fence !== null ||
        job.builder_id !== null ||
        job.snapshot !== null
      )
        throw new GoldenError(
          "conflict",
          "This build has already started or needs recovery; cancellation cannot safely release its reservation. Check build status and ask an administrator to reconcile it.",
        );
      if (job.reservation_id) await sqlGoldenBackendSlots(sql).release(job.reservation_id);
      await sql.query(
        "update public.golden_build_jobs set state='failed',error_code='build_failed',failure_reason=$2,updated_at=now() where id=$1",
        [job.id, reason],
      );
      return this.dto({ ...job, state: "failed", error_code: "build_failed", failure_reason: reason });
    });
  }

  private dto(job: Job, name?: string): GoldenBuildStatus {
    return {
      jobId: job.id,
      provider: job.provider,
      state: job.state,
      phase: job.phase,
      errorCode: job.error_code,
      failureReason: job.failure_reason,
      result:
        job.state === "succeeded" && job.snapshot
          ? {
              name: name ?? job.name,
              visibility: job.visibility,
              snapshot: job.snapshot,
              warnings: job.build_warnings ?? [],
            }
          : null,
    };
  }
  private async ownsLease(sql: Sql, id: string, epoch: string, lock = true) {
    const lease = await sql.query(
      `select id from public.jobs where id=$1 and kind='golden_build' and state='leased' and lease_epoch=$2
         and lease_until>clock_timestamp()${lock ? " for update" : ""}`,
      [id, epoch],
    );
    return lease.rows.length > 0;
  }
  private async lock(sql: Sql, job: Job, epoch: string, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    const owned = (
      await sql.query<{ id: string }>(
        "select id from public.golden_build_jobs where id=$1 and state='running' and fence=$2 and deadline>clock_timestamp() for update",
        [job.id, job.fence],
      )
    ).rows[0];
    if (!owned) throw new GoldenError("build_failed", "Build lease is no longer owned.");
    await this.actor(sql, job);
    if (job.reservation_id) {
      const slot = (
        await sql.query("select id from public.golden_backend_slots where build_id=$1", [job.reservation_id])
      ).rows[0];
      if (!slot) throw new GoldenError("build_failed", "Build reservation is no longer owned.");
    } else if (PROVIDER_LIMITS[job.provider].defaultGoldenCapacity !== undefined)
      throw new GoldenError("build_failed", "Build reservation is missing.");
    if (!(await this.ownsLease(sql, job.id, epoch, false)))
      throw new GoldenError("build_failed", "Build lease is no longer owned.");
    signal?.throwIfAborted();
  }
  private async context(job: Job): Promise<Input> {
    const raw = JSON.parse(await decryptSecret(job.payload_enc, this.options.encryptionKey));
    if (!raw || typeof raw !== "object" || (raw.provider ?? "boat") !== job.provider)
      throw new GoldenError("forbidden", "Build provider context changed.");
    const input: Input = { ...raw };
    if (raw.setup === null) delete input.setup;
    if (raw.config === null) delete input.config;
    if (raw.existingGolden === null) delete input.existingGolden;
    if (raw.modal === null) delete input.modal;
    buildTarget(job.provider, job.org_id, input);
    return input;
  }
  private async resolve(job: Job, actor: GoldenActor, input: Input, signal?: AbortSignal): Promise<Provider> {
    signal?.throwIfAborted();
    const provider = await this.options.provider(actor, job.visibility, buildTarget(job.provider, job.org_id, input));
    signal?.throwIfAborted();
    assertProviderOf(provider, job.provider);
    if (job.reservation_id) {
      const identity = await provider.backendIdentity?.();
      signal?.throwIfAborted();
      const slot = (
        await this.options.sql.query<{ backend_id: string; provider: string }>(
          "select backend_id,provider from public.golden_backend_slots where build_id=$1",
          [job.reservation_id],
        )
      ).rows[0];
      if (!identity || !slot || slot.provider !== job.provider || slot.backend_id !== identity.id)
        throw new GoldenError("forbidden", "Build backend binding changed.");
    } else if (PROVIDER_LIMITS[job.provider].defaultGoldenCapacity !== undefined || provider.maxGoldens !== undefined) {
      throw new GoldenError("forbidden", "Build capacity policy changed.");
    }
    return provider;
  }
  /** Reconcile only the attempt identified by the shared job. */
  private async recoverReceipt(row: Job, signal?: AbortSignal) {
    const reservationRecovery = HOST_CAPABILITIES[row.provider].goldenBuilderRecovery === "dispose-reservation";
    const authorizationOnly = row.phase === "authorization" && row.builder_id === null && row.snapshot === null;
    if (
      !row.fence ||
      (!authorizationOnly && !row.builder_id && !row.snapshot && !(reservationRecovery && row.phase === "builder"))
    )
      return;
    signal?.throwIfAborted();
    if (authorizationOnly) {
      // createGolden is called only after the durable builder phase is fenced.
      // A late authorization callback cannot enter that phase after recovery owns
      // the row. No provider resource exists to stop or inspect in this state.
      await this.transaction(async (sql) => {
        const current = (
          await sql.query<Job>("select * from public.golden_build_jobs where id=$1 for update", [row.id])
        ).rows[0];
        if (
          !current ||
          current.state !== "recovery_required" ||
          current.phase !== "authorization" ||
          current.fence !== row.fence ||
          current.reservation_id !== row.reservation_id ||
          current.builder_id !== null ||
          current.snapshot !== null
        )
          return;
        signal?.throwIfAborted();
        if (current.reservation_id) await sqlGoldenBackendSlots(sql).release(current.reservation_id);
        await sql.query(
          "update public.golden_build_jobs set state='failed',failure_reason=case when failure_reason=$3 then $2 else coalesce(failure_reason,$2) end,updated_at=now() where id=$1",
          [
            current.id,
            "detail:Build expired during authorization before any builder started. Its reservation was released; start a new build request when ready.",
            INTERRUPTED_BUILD,
          ],
        );
      });
      return;
    }
    // A recovery row's snapshot is the candidate its worker recorded under the fence before
    // publication (see executeReceipt's candidate). Publication commits only together with complete(),
    // which requires this fence in state running under the same row lock; a committed row in
    // recovery_required therefore proves that candidate was never published and never can be.
    const rolledBack = row.snapshot;
    // Never dispose a source whose snapshot/publication outcome may still depend on it.
    if (reservationRecovery && !rolledBack && (row.phase === "snapshot" || row.phase === "persist")) return;
    try {
      const actor = await this.transaction((sql) => this.actor(sql, row));
      signal?.throwIfAborted();
      const input = await this.context(row);
      if (
        input.name !== row.name ||
        input.visibility !== row.visibility ||
        (input.existingGolden?.id ?? null) !== row.golden_id
      )
        return;
      const provider = await this.resolve(row, actor, input, signal);
      signal?.throwIfAborted();
      if (reservationRecovery && (!provider.findGoldenBuilder || !provider.disposeGoldenBuilder)) return;
      // The unpublished artifact must be gone before the builder or the capacity is released.
      // Recovery resumes wherever the worker stopped: a still-live artifact is retired first (an
      // already-retired one is not retired again), and a pending collection is retried on a later
      // tick with the job's original authority.
      if (rolledBack) {
        if (!provider.collectRetiredSnapshot) return;
        // Defence in depth: never retire an artifact some golden still names.
        if (
          (
            await this.options.sql.query("select 1 from public.goldens where provider_snapshot_id=$1 limit 1", [
              rolledBack,
            ])
          ).rows.length
        )
          return;
        signal?.throwIfAborted();
        const live = await provider.getSnapshot(rolledBack).then(
          () => true,
          (error: unknown) => {
            if ((error as { code?: unknown } | null)?.code === "not_found") return false;
            throw error;
          },
        );
        signal?.throwIfAborted();
        if (live) await provider.deleteSnapshot(rolledBack);
        signal?.throwIfAborted();
        if ((await provider.collectRetiredSnapshot(rolledBack)) !== "collected") return;
      }
      signal?.throwIfAborted();
      // Proof for the provider that this builder's own snapshot was this collected rolled-back artifact.
      const collected = rolledBack ? { collected: rolledBack } : {};
      let builderId = row.builder_id;
      let retained = false;
      if (reservationRecovery && provider.findGoldenBuilder) {
        const found = await provider.findGoldenBuilder({
          requestKey: row.id,
          ownerId: row.owner_id,
          target: buildTarget(row.provider, row.org_id, input),
          ...collected,
        });
        if (!found || !found.sandboxId || (builderId !== null && builderId !== found.sandboxId)) return;
        builderId = found.sandboxId;
        retained = found.disposition !== "disposable";
      } else if (!builderId) return;
      signal?.throwIfAborted();
      const owned = await this.transaction(async (sql) => {
        const current = (
          await sql.query<Job>("select * from public.golden_build_jobs where id=$1 for update", [row.id])
        ).rows[0];
        if (
          !current ||
          current.state !== "recovery_required" ||
          current.fence !== row.fence ||
          current.phase !== row.phase ||
          current.snapshot !== row.snapshot ||
          current.request_hash !== row.request_hash ||
          current.provider !== row.provider ||
          current.owner_id !== row.owner_id ||
          current.org_id !== row.org_id ||
          current.visibility !== row.visibility ||
          !Buffer.from(current.payload_enc).equals(Buffer.from(row.payload_enc)) ||
          (current.builder_id !== null && current.builder_id !== builderId)
        )
          return false;
        await this.actor(sql, current);
        signal?.throwIfAborted();
        // Commit the logical identity under the existing fence BEFORE any provider action.
        const saved = await sql.query(
          "update public.golden_build_jobs set builder_id=$3,updated_at=now() where id=$1 and fence=$2 and state='recovery_required' returning id",
          [row.id, row.fence, builderId],
        );
        return saved.rows.length === 1;
      });
      if (!owned || retained || (reservationRecovery && provider.findGoldenBuilder && !provider.disposeGoldenBuilder))
        return;
      signal?.throwIfAborted();
      // Reservation disposal performs exact named ownership reconciliation under its lease.
      if (reservationRecovery) {
        const dispose = provider.disposeGoldenBuilder;
        if (!dispose) return;
        const receipt = await dispose({
          requestKey: row.id,
          ownerId: row.owner_id,
          target: buildTarget(row.provider, row.org_id, input),
          sandboxId: builderId,
          ...collected,
        });
        if (receipt.status !== "deleted") return;
      } else await provider.stop({ sandboxId: builderId });
      signal?.throwIfAborted();
      await this.transaction(async (sql) => {
        const current = (
          await sql.query<Job>("select * from public.golden_build_jobs where id=$1 for update", [row.id])
        ).rows[0];
        if (
          current?.state !== "recovery_required" ||
          current.fence !== row.fence ||
          current.builder_id !== builderId ||
          current.phase !== row.phase
        )
          return;
        await this.actor(sql, current);
        signal?.throwIfAborted();
        if (row.reservation_id) await sqlGoldenBackendSlots(sql).release(row.reservation_id);
        await sql.query(
          "update public.golden_build_jobs set state='failed',failure_reason=coalesce(failure_reason,$2),updated_at=now() where id=$1",
          [row.id, INTERRUPTED_BUILD],
        );
      });
    } catch {
      /* Unknown outcomes retain capacity, source and proof. No exception/payload/SDK logging. */
    }
  }
  async dispatchReceipt(
    id: string,
    leaseEpoch: string,
    signal?: AbortSignal,
    runRecovery = async (work: (signal?: AbortSignal) => Promise<void>) => {
      await work(signal);
      return true;
    },
  ) {
    // Encode the bigint claim epoch in the receipt's existing UUID attempt identity.
    const epochHex = BigInt(leaseEpoch).toString(16).padStart(16, "0");
    const fence = `00000000-0000-0000-${epochHex.slice(0, 4)}-${epochHex.slice(4)}`;
    const job = await this.transaction(async (sql) => {
      const row = (
        await sql.query<Job & { expired: boolean }>(
          "select *, created_at <= clock_timestamp()-interval '60 minutes' as expired from public.golden_build_jobs where id=$1 for update",
          [id],
        )
      ).rows[0];
      if (!row || row.state === "succeeded" || row.state === "failed") return row;
      if (!(await this.ownsLease(sql, id, leaseEpoch))) return row;
      signal?.throwIfAborted();
      if (row.state === "running") {
        const expired = await sql.query(
          `update public.golden_build_jobs set state='recovery_required',error_code='build_failed',failure_reason=coalesce(failure_reason,$3),updated_at=now()
            where id=$1 and (deadline<=clock_timestamp() or lease_until<=clock_timestamp()
              or (lease_until='infinity' and fence<>$2)) returning id`,
          [id, fence, INTERRUPTED_BUILD],
        );
        return expired.rows.length ? { ...row, state: "recovery_required" as const, recover: true } : row;
      }
      if (row.state === "recovery_required") return { ...row, recover: true };
      if (row.expired) {
        // The same row lock fences other workers' claims. Only a never-started
        // admission can release capacity without reconciling provider resources.
        const unstarted =
          row.phase === "queued" && row.fence === null && row.builder_id === null && row.snapshot === null;
        if (unstarted && row.reservation_id) await sqlGoldenBackendSlots(sql).release(row.reservation_id);
        const state: Job["state"] = unstarted ? "failed" : "recovery_required";
        await sql.query(
          "update public.golden_build_jobs set state=$2,error_code='build_failed',failure_reason=$3,updated_at=now() where id=$1",
          [
            row.id,
            state,
            unstarted
              ? "detail:Build expired after one hour waiting in the queue; no builder was started. Retry the rebuild."
              : "detail:Expired queued build has execution evidence. Ask an administrator to reconcile it before retrying.",
          ],
        );
        return { ...row, state, processed: true };
      }
      await sql.query("select pg_advisory_xact_lock(hashtextextended('armada.jobs:golden_build',0))");
      // During database overlap, an older replica can still be executing under a finite
      // receipt lease. Lock those rows before checking time so a concurrent renewal is visible.
      const occupied = await sql.query(
        `with previous_attempts as materialized (
           select lease_until, deadline from public.golden_build_jobs
            where state='running' and lease_until<'infinity' for update
         )
         select 1 from previous_attempts where lease_until>clock_timestamp() and deadline>clock_timestamp()`,
      );
      if (occupied.rows.length || !(await this.ownsLease(sql, id, leaseEpoch))) return row;
      signal?.throwIfAborted();
      const { rows } = await sql.query<Job>(
        "update public.golden_build_jobs set state='running',phase='authorization',fence=$2,lease_until='infinity',deadline=clock_timestamp()+interval '60 minutes',updated_at=now() where id=$1 returning *",
        [row.id, fence],
      );
      return { ...rows[0]!, processed: true };
    });
    if (!job) return { processed: false, pending: false };
    const processed = "processed" in job;
    let state = job.state;
    if ("recover" in job || (processed && state === "running")) {
      if ("recover" in job) {
        if (!(await runRecovery((recoverySignal) => this.recoverReceipt(job, recoverySignal))))
          return { processed, pending: true };
      } else await this.executeReceipt(job, leaseEpoch, signal);
      const { rows } = await this.options.sql.query<Pick<Job, "state">>(
        "select state from public.golden_build_jobs where id=$1",
        [id],
      );
      state = rows[0]?.state ?? "failed";
    }
    return { processed, pending: state === "queued" || state === "running" || state === "recovery_required" };
  }

  private async executeReceipt(job: Job, epoch: string, signal?: AbortSignal) {
    let safeToRelease = true;
    // The candidate this attempt tried to record before publication, kept even when that record
    // failed: an unsafe outcome retries it under the fence in the final write.
    let unpublished: string | null = null;
    try {
      const actor = await this.transaction((sql) => this.actor(sql, job));
      const input = await this.context(job);
      const provider = await this.resolve(job, actor, input, signal);
      const phase = async (next: string) => {
        await this.transaction(async (sql) => {
          await this.lock(sql, job, epoch, signal);
          if (!(await this.ownsLease(sql, job.id, epoch)))
            throw new GoldenError("build_failed", "Build lease is no longer owned.", {
              safeMessage: "The build worker lost its lease.",
            });
          const changed = await sql.query(
            "update public.golden_build_jobs set phase=$2,updated_at=now() where id=$1 and deadline>clock_timestamp() returning id",
            [job.id, next],
          );
          if (!changed.rows.length || !(await this.ownsLease(sql, job.id, epoch, false)))
            throw new GoldenError("build_failed", "Build lease or deadline expired.", {
              safeMessage: "The build worker lost its lease or reached the build deadline.",
            });
          signal?.throwIfAborted();
          if (next === "builder") safeToRelease = false;
        });
        signal?.throwIfAborted();
      };
      const service = createGoldenCreateService({
        ...this.options.service,
        sql: this.options.sql,
        job: {
          id: job.id,
          ...(job.reservation_id ? { reservationId: job.reservation_id } : {}),
          phase,
          cleaned: (safe) => {
            safeToRelease = safe;
          },
          // Recovery retains the attempt fence so it can see a late snapshot.
          candidate: async (snapshot) => {
            unpublished = snapshot;
            const saved = await this.options.sql.query(
              "update public.golden_build_jobs set snapshot=$3,updated_at=now() where id=$1 and fence=$2 and state in ('running','recovery_required') and (snapshot is null or snapshot=$3) returning id",
              [job.id, job.fence, snapshot],
            );
            if (!saved.rows.length) throw new GoldenError("build_failed", "Build lease is no longer owned.");
          },
          builder: async (id) => {
            const saved = await this.options.sql.query(
              "update public.golden_build_jobs set builder_id=$3 where id=$1 and fence=$2 and state in ('running','recovery_required') and (builder_id is null or builder_id=$3) returning id",
              [job.id, job.fence, id],
            );
            if (!saved.rows.length) throw new GoldenError("build_failed", "Build attempt is no longer recoverable.");
            await this.transaction((sql) => this.lock(sql, job, epoch, signal));
          },
          lock: (sql) => this.lock(sql, job, epoch, signal),
          complete: async (sql, goldenId, snapshot, warnings) => {
            // Recheck with wall time at the final write: PostgreSQL now() is frozen at
            // transaction start, and the lease may have expired while publication waited.
            signal?.throwIfAborted();
            if (!(await this.ownsLease(sql, job.id, epoch)))
              throw new GoldenError("build_failed", "Build lease expired before publication.");
            const completed = await sql.query(
              `update public.golden_build_jobs set state='succeeded',phase='complete',golden_id=$3,snapshot=$4,
                 build_warnings=$5::text[],lease_until=null,updated_at=now()
               where id=$1 and fence=$2 and state='running' and deadline>clock_timestamp()
                 and exists (select 1 from public.jobs where id=$1 and kind='golden_build' and state='leased'
                   and lease_epoch=$6 and lease_until>clock_timestamp()) returning id`,
              [job.id, job.fence, goldenId, snapshot, "{" + warnings.join(",") + "}", epoch],
            );
            if (!completed.rows.length)
              throw new GoldenError("build_failed", "Build lease expired before publication.");
            signal?.throwIfAborted();
          },
        },
      });
      await service.create(provider, actor, input, {
        sleep: async (ms) => {
          await this.transaction((sql) => this.lock(sql, job, epoch, signal));
          await new Promise<void>((resolve) => setTimeout(resolve, ms));
        },
      });
    } catch (error) {
      // No exception object: arbitrary provider errors and payloads may carry secrets.
      await this.transaction(async (sql) => {
        const current = (
          await sql.query<Job>("select * from public.golden_build_jobs where id=$1 for update", [job.id])
        ).rows[0];
        if (!current || current.fence !== job.fence) return;
        const reason = receiptFailureReason(error, current.phase, safeToRelease);
        if (current.state === "recovery_required") {
          // Preserve late evidence under the original attempt fence. Recovery still owns the phase.
          await sql.query(
            `update public.golden_build_jobs
             set snapshot=coalesce(snapshot,$2),
                 failure_reason=case when failure_reason is null or failure_reason=$3 then $4 else failure_reason end,
                 updated_at=now() where id=$1`,
            [job.id, unpublished, INTERRUPTED_BUILD, reason === FAILED_BUILD ? INTERRUPTED_BUILD : reason],
          );
          return;
        }
        if (current.state !== "running") return;
        const subphase = error instanceof GoldenError ? error.safePhase : undefined;
        const phase = (subphase && GOLDEN_SSH_RECEIPT_PHASES[subphase]) ?? current.phase;
        if (safeToRelease && job.reservation_id) await sqlGoldenBackendSlots(sql).release(job.reservation_id);
        await sql.query(
          "update public.golden_build_jobs set state=$2,error_code='build_failed',failure_reason=$3,phase=$4,snapshot=case when $5::boolean then null else coalesce(snapshot,$6) end,lease_until=null,updated_at=now() where id=$1",
          [job.id, safeToRelease ? "failed" : "recovery_required", reason, phase, safeToRelease, unpublished],
        );
      });
    }
  }
}

/** Copies only immutable routing metadata. Never retain a factory, token or local profile in a job. */
function buildTarget(provider: SandboxProviderId, orgId: string, input: Input): ProviderTarget {
  const binding = input.existingGolden?.modal ?? input.modal ?? null;
  let modal: ModalBinding | null = null;
  if (HOST_CAPABILITIES[provider].requiresPinnedGoldenBinding) {
    if (
      !binding ||
      [binding.workspace, binding.environment, binding.appId].some((v) => typeof v !== "string" || !v.trim())
    )
      throw new GoldenError("forbidden", "A verified pinned Modal App binding is required.");
    modal = { workspace: binding.workspace, environment: binding.environment, appId: binding.appId };
    if (
      input.modal &&
      (input.modal.workspace !== modal.workspace ||
        input.modal.environment !== modal.environment ||
        input.modal.appId !== modal.appId)
    )
      throw new GoldenError("forbidden", "Build Modal binding changed.");
  } else if (binding) throw new GoldenError("forbidden", "Boat jobs cannot carry a Modal binding.");
  if (input.existingGolden && (input.existingGolden.provider !== provider || input.existingGolden.orgId !== orgId))
    throw new GoldenError("forbidden", "Build source provider or organization changed.");
  return {
    provider,
    orgId,
    visibility: input.visibility,
    sourceGoldenVisibility: input.existingGolden?.visibility ?? input.visibility,
    modal,
  };
}
