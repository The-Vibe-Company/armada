import { createHash, randomUUID } from "node:crypto";
import { decryptSecret, encryptSecret } from "./crypto.ts";
import type { GoldenActor } from "./golden.ts";
import { assertGoldenMutation } from "./golden.ts";
import type { GoldenBuildStatus } from "./golden-build-status.ts";
import type { GoldenBuildWarning } from "./golden-build-warning.ts";
import { GoldenError, parseGoldenName } from "./golden-config.ts";
import {
  createGoldenCreateService,
  type GoldenCreateOptions,
  reserveGoldenBuild,
  sqlGoldenBackendSlots,
} from "./golden-create.ts";
import type { GoldenCreateService } from "./golden-create-service.ts";
import type { Sql } from "./golden-store.ts";
import type { Provider } from "./provider.ts";
import {
  assertProviderOf,
  isSandboxProvider,
  type ModalBinding,
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
  fence: string;
  builder_id: string | null;
  golden_id: string | null;
  snapshot: string | null;
  build_warnings: GoldenBuildWarning[];
  failure_reason: "skillpack_integrity_failed" | null;
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
    // ExistingGolden is re-read by routes; retries after success must still match the submitted config,
    // not the new snapshot pointer. The target ID is immutable; expected revision lives only in payload.
    const hash = createHash("sha256")
      .update(
        JSON.stringify({
          name: input.name,
          visibility: input.visibility,
          repos: input.repos,
          config: input.config ?? null,
          setup: input.setup ?? null,
          goldenId: input.existingGolden?.id ?? null,
          // Preserve pre-migration Boat request hashes for durable idempotent retries.
          ...(providerId === "boat" ? {} : { provider: providerId, modal: target.modal }),
        }),
      )
      .digest("hex");
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
        if (prior.request_hash !== hash || prior.provider !== providerId)
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
          (providerId === "modal" &&
            (current.modal_workspace !== target.modal?.workspace ||
              current.modal_environment !== target.modal?.environment ||
              current.modal_app_id !== target.modal?.appId))
        )
          throw new GoldenError("conflict", "Golden changed before build admission.");
      }
      // The server factory verifies the pinned management connection, never a client profile label.
      // It may read App metadata here, but must not allocate a builder before this transaction commits.
      const verified =
        providerId === "modal" ? await this.options.provider(currentActor, input.visibility, target) : provider;
      assertProviderOf(verified, providerId);
      const reservation = await reserveGoldenBuild(sql, verified, currentActor, input.existingGolden);
      if (!reservation && providerId === "boat")
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
  private async lock(sql: Sql, job: Job): Promise<void> {
    const owned = (
      await sql.query<{ id: string }>(
        "select id from public.golden_build_jobs where id=$1 and state='running' and fence=$2 and lease_until>clock_timestamp() and deadline>clock_timestamp() for update",
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
    } else if (job.provider !== "modal") throw new GoldenError("build_failed", "Build reservation is missing.");
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
  private async resolve(job: Job, actor: GoldenActor, input: Input): Promise<Provider> {
    const provider = await this.options.provider(actor, job.visibility, buildTarget(job.provider, job.org_id, input));
    assertProviderOf(provider, job.provider);
    if (job.reservation_id) {
      const identity = await provider.backendIdentity?.();
      const slot = (
        await this.options.sql.query<{ backend_id: string; provider: string }>(
          "select backend_id,provider from public.golden_backend_slots where build_id=$1",
          [job.reservation_id],
        )
      ).rows[0];
      if (!identity || !slot || slot.provider !== job.provider || slot.backend_id !== identity.id)
        throw new GoldenError("forbidden", "Build backend binding changed.");
    } else if (job.provider !== "modal" || provider.maxGoldens !== undefined) {
      throw new GoldenError("forbidden", "Build capacity policy changed.");
    }
    return provider;
  }
  /** Reconcile a fenced abandoned attempt, never restart its commands or delete snapshots. */
  async reconcileOne(): Promise<void> {
    const row = (
      await this.options.sql.query<Job>(
        "select * from public.golden_build_jobs where state='recovery_required' and (builder_id is not null or (provider='modal' and phase='builder')) order by updated_at limit 1",
      )
    ).rows[0];
    if (!row) return;
    // Fairness bookkeeping only: retained, unauthorized or temporarily unavailable heads
    // must not starve other abandoned jobs. Never change their fence/state/capacity/proof.
    const attempted = await this.options.sql.query(
      "update public.golden_build_jobs set updated_at=clock_timestamp() where id=$1 and state='recovery_required' and fence is not distinct from $2::uuid returning id",
      [row.id, row.fence],
    );
    if (!attempted.rows.length || !row.fence) return;
    // Never dispose a source whose snapshot/publication outcome may still depend on it.
    if (row.provider === "modal" && (row.phase === "snapshot" || row.phase === "persist")) return;
    try {
      const actor = await this.transaction((sql) => this.actor(sql, row));
      const input = await this.context(row);
      if (
        input.name !== row.name ||
        input.visibility !== row.visibility ||
        (input.existingGolden?.id ?? null) !== row.golden_id
      )
        return;
      const provider = await this.resolve(row, actor, input);
      if (row.provider === "modal" && (!provider.findGoldenBuilder || !provider.disposeGoldenBuilder)) return;
      let builderId = row.builder_id;
      let retained = false;
      if (row.provider === "modal" && provider.findGoldenBuilder) {
        const found = await provider.findGoldenBuilder({
          requestKey: row.id,
          ownerId: row.owner_id,
          target: buildTarget(row.provider, row.org_id, input),
        });
        if (!found || !found.sandboxId || (builderId !== null && builderId !== found.sandboxId)) return;
        builderId = found.sandboxId;
        retained = found.disposition !== "disposable";
      } else if (!builderId) return;
      const owned = await this.transaction(async (sql) => {
        const current = (
          await sql.query<Job>("select * from public.golden_build_jobs where id=$1 for update", [row.id])
        ).rows[0];
        if (
          !current ||
          current.state !== "recovery_required" ||
          current.fence !== row.fence ||
          current.phase !== row.phase ||
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
        // Commit the logical identity under the existing fence BEFORE any provider action.
        const saved = await sql.query(
          "update public.golden_build_jobs set builder_id=$3,updated_at=now() where id=$1 and fence=$2 and state='recovery_required' returning id",
          [row.id, row.fence, builderId],
        );
        return saved.rows.length === 1;
      });
      if (
        !owned ||
        retained ||
        (row.provider === "modal" && provider.findGoldenBuilder && !provider.disposeGoldenBuilder)
      )
        return;
      // Modal disposal already performs exact named ownership reconciliation under its lease.
      if (row.provider === "modal") {
        const dispose = provider.disposeGoldenBuilder;
        if (!dispose) return;
        const receipt = await dispose({
          requestKey: row.id,
          ownerId: row.owner_id,
          target: buildTarget(row.provider, row.org_id, input),
          sandboxId: builderId,
        });
        if (receipt.status !== "deleted") return;
      } else await provider.stop({ sandboxId: builderId });
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
        if (row.reservation_id) await sqlGoldenBackendSlots(sql).release(row.reservation_id);
        await sql.query("update public.golden_build_jobs set state='failed',updated_at=now() where id=$1", [row.id]);
      });
    } catch {
      /* Unknown outcomes retain capacity, source and proof. No exception/payload/SDK logging. */
    }
  }
  /** One bounded worker tick; callers own scheduling and graceful shutdown. Never reclaims expired work. */
  async runOne(): Promise<boolean> {
    await this.options.sql.query(
      "update public.golden_build_jobs set state='recovery_required',error_code='build_failed',updated_at=now() where state='running' and (lease_until<=clock_timestamp() or deadline<=clock_timestamp())",
    );
    const job = await this.transaction(async (sql) => {
      const row = (
        await sql.query<Job>(
          "select * from public.golden_build_jobs where state='queued' order by created_at for update skip locked limit 1",
        )
      ).rows[0];
      if (!row) return undefined;
      return (
        await sql.query<Job>(
          "update public.golden_build_jobs set state='running',phase='authorization',fence=$2,lease_until=clock_timestamp()+interval '60 seconds',deadline=clock_timestamp()+interval '60 minutes',updated_at=now() where id=$1 returning *",
          [row.id, randomUUID()],
        )
      ).rows[0]!;
    });
    if (!job) return false;
    let safeToRelease = true;
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    try {
      const actor = await this.transaction((sql) => this.actor(sql, job));
      const input = await this.context(job);
      const provider = await this.resolve(job, actor, input);
      const phase = async (next: string) =>
        this.transaction(async (sql) => {
          await this.lock(sql, job);
          await sql.query("update public.golden_build_jobs set phase=$2,updated_at=now() where id=$1", [job.id, next]);
          if (next === "builder") safeToRelease = false;
        });
      // A live worker renews only its own unexpired fence. A database outage fences publication.
      heartbeat = setInterval(() => {
        void this.options.sql
          .query(
            "update public.golden_build_jobs set lease_until=clock_timestamp()+interval '60 seconds' where id=$1 and fence=$2 and state='running' and lease_until>clock_timestamp() and deadline>clock_timestamp()",
            [job.id, job.fence],
          )
          .catch(() => {});
      }, 10_000);
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
          builder: async (id) =>
            this.transaction(async (sql) => {
              await this.lock(sql, job);
              await sql.query("update public.golden_build_jobs set builder_id=$2 where id=$1", [job.id, id]);
            }),
          lock: (sql) => this.lock(sql, job),
          complete: async (sql, goldenId, snapshot, warnings) => {
            // Recheck with wall time at the final write: PostgreSQL now() is frozen at
            // transaction start, and the lease may have expired while publication waited.
            const completed = await sql.query(
              "update public.golden_build_jobs set state='succeeded',phase='complete',golden_id=$3,snapshot=$4,build_warnings=$5::text[],lease_until=null,updated_at=now() where id=$1 and fence=$2 and state='running' and lease_until>clock_timestamp() and deadline>clock_timestamp() returning id",
              [job.id, job.fence, goldenId, snapshot, "{" + warnings.join(",") + "}"],
            );
            if (!completed.rows.length)
              throw new GoldenError("build_failed", "Build lease expired before publication.");
          },
        },
      });
      await service.create(provider, actor, input, {
        sleep: async (ms) => {
          await this.transaction((sql) => this.lock(sql, job));
          await new Promise<void>((resolve) => setTimeout(resolve, ms));
        },
      });
    } catch (error) {
      // No exception object: arbitrary provider errors and payloads may carry secrets.
      await this.transaction(async (sql) => {
        const current = (
          await sql.query<Job>("select * from public.golden_build_jobs where id=$1 for update", [job.id])
        ).rows[0];
        if (current?.state !== "running" || current.fence !== job.fence) return;
        if (safeToRelease && job.reservation_id) await sqlGoldenBackendSlots(sql).release(job.reservation_id);
        await sql.query(
          "update public.golden_build_jobs set state=$2,error_code='build_failed',failure_reason=$3,lease_until=null,updated_at=now() where id=$1",
          [
            job.id,
            safeToRelease ? "failed" : "recovery_required",
            error instanceof GoldenError ? (error.safeReason ?? null) : null,
          ],
        );
      });
    } finally {
      if (heartbeat) clearInterval(heartbeat);
    }
    return true;
  }
}

/** Copies only immutable routing metadata. Never retain a factory, token or local profile in a job. */
function buildTarget(provider: SandboxProviderId, orgId: string, input: Input): ProviderTarget {
  const binding = input.existingGolden?.modal ?? input.modal ?? null;
  let modal: ModalBinding | null = null;
  if (provider === "modal") {
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
