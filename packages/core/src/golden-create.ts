import type { GitHubInstallationApp, GitHubResolveDeps } from "./github.ts";
import { resolveGitHubAccess } from "./github.ts";
import type { GoldenActor, GoldenRecord } from "./golden.ts";
import type { GoldenBuildWarning } from "./golden-build-warning.ts";
import type { GoldenConfig, GoldenRepo } from "./golden-config.ts";
import { GoldenError } from "./golden-config.ts";
import { type GoldenCreateDeps, GoldenCreateService } from "./golden-create-service.ts";
import { goldenGitHubAdapter } from "./golden-github.ts";
import { verifyGoldenHelper } from "./golden-helper.ts";
import { scanGoldenSandbox } from "./golden-scan.ts";
import {
  captureGoldenPublication,
  captureHistoricalPublication,
  enqueueGoldenRetirement,
  recordGoldenPublication,
} from "./golden-snapshot-retirement.ts";
import { createSqlGoldenStore, type Sql } from "./golden-store.ts";
import { type Provider, ProviderError } from "./provider.ts";
import { sshStdinCheckout } from "./ssh-executor.ts";

export interface GoldenBackendSlot {
  reserve(input: {
    provider: string;
    backendId: string;
    capacity: number;
    orgId: string;
    ownerId: string;
  }): Promise<string>;
  reserveExisting(input: { provider: string; backendId: string; capacity: number; goldenId: string }): Promise<string>;
  finalize(reservationId: string, goldenId: string): Promise<void>;
  release(reservationId: string): Promise<void>;
}

export interface GoldenCreateOptions {
  /** Trusted durable-job execution fence, never supplied by a client. */
  job?: {
    id: string;
    reservationId?: string | null;
    cleaned(safe: boolean): void;
    phase(phase: string): Promise<void>;
    builder(id: string): Promise<void>;
    lock(sql: Sql): Promise<void>;
    complete(sql: Sql, goldenId: string, snapshot: string, warnings: GoldenBuildWarning[]): Promise<void>;
  };
  /** The privileged database connection the server already holds (shared with the control API). */
  sql: Sql;
  /** How the caller's own cached OAuth access token (#492) is resolved for checkout; never an App token. */
  github: GitHubResolveDeps;
  /**
   * The GitHub App's server-only signing credentials, for an optional scoped, one-hour installation
   * token that is revoked right after checkout. Null (no `GITHUB_APP_PRIVATE_KEY`): checkout uses the
   * caller's own cached token instead, which is never rotated or revoked for a build.
   */
  installationApp: GitHubInstallationApp | null;
  /** GitHub REST calls (repos, installations, installation tokens). Defaults to the global `fetch`. */
  fetch?: typeof fetch;
  /** For tests: overrides the pinned SSH stdin transport, which otherwise spawns real `ssh-keygen`/`ssh`. */
  ssh?: GoldenCreateDeps["ssh"];
  /** Server-only global backend capacity. Omit for providers without a backend limit. */
  backendSlot?: GoldenBackendSlot;
  /** Boat is the secure-create default: one logical golden per backend account. */
  defaultProviderCapacity?: number;
}

/**
 * Wires `GoldenCreateService` to the real server: the caller's own cached OAuth token resolves and
 * authorizes the requested repos; checkout uses that token, or a scoped installation token when the
 * App is configured; the pinned SSH stdin transport clones over it; a fail-closed secret scan runs
 * before the snapshot; and only a ready snapshot is persisted, with org/private row level security.
 */
export function createGoldenCreateService(options: GoldenCreateOptions): GoldenCreateService {
  const adapter = goldenGitHubAdapter({
    app: options.installationApp,
    ...(options.fetch ? { fetch: options.fetch } : {}),
    async accessToken(actor: GoldenActor) {
      const access = await resolveGitHubAccess({ ...options.github, caller: "golden_create" }, actor.userId);
      if (access.status !== "connected") throw new GoldenError("forbidden", access.message);
      return access.token;
    },
  });
  const slots: GoldenBackendSlot = options.backendSlot ?? sqlGoldenBackendSlots(options.sql);
  // Identity proof of a callback failure whose managed transaction has completed rollback.
  // A commit/transport error after a successful callback is deliberately never marked here.
  const rolledBack = new WeakMap<object, string>();
  let buildProvider: Provider | undefined;
  const deps: GoldenCreateDeps = {
    authorize: adapter.authorize,
    ssh:
      options.ssh ??
      ((provider, input) =>
        sshStdinCheckout(provider, input, { ...(input.onWarning ? { onWarning: input.onWarning } : {}) })),
    verifyHelper: verifyGoldenHelper,
    scan: (provider, sandboxId, context) => scanGoldenSandbox(provider, sandboxId, context),
    async reserve(provider, actor, existingGolden) {
      buildProvider = provider;
      if (options.job) {
        await options.job.phase("authorization");
        const reservation = options.job.reservationId ?? undefined;
        if (provider.id === "boat" && !reservation)
          throw new GoldenError("conflict", "Boat job has no owned backend reservation.");
        if (existingGolden && reservation) {
          const identity = await provider.backendIdentity?.();
          if (!identity) throw new GoldenError("forbidden", "Provider cannot verify backend identity.");
          const binding = await options.sql.query(
            "select id from public.golden_backend_slots where provider=$1 and backend_id=$2 and golden_id=$3 and build_id=$4",
            [provider.id, identity.id, existingGolden.id, reservation],
          );
          if (!binding.rows.length) throw new GoldenError("conflict", "Build backend binding changed.");
        }
        return reservation;
      }
      if (!options.sql.transaction)
        throw new GoldenError("conflict", "Atomic golden persistence requires a database transaction.");
      return reserveGoldenBuild(options.sql, provider, actor, existingGolden, slots, options.defaultProviderCapacity);
    },
    async release(reservationId) {
      if (!options.job) await slots.release(reservationId);
    },
    async claimRevision(provider, actor, golden, name, builderId) {
      const backend = (await provider.backendIdentity?.())?.id;
      if (!backend || !options.sql.transaction)
        throw new GoldenError("conflict", "Revision namespace cannot be verified.");
      const authority = (await provider.managementIdentity?.()) ?? null;
      const target = {
        provider: golden.provider,
        orgId: golden.orgId,
        ownerId: golden.ownerId,
        visibility: golden.visibility,
        modal: golden.modal,
      };
      await options.sql.transaction(async (tx) => {
        await options.job?.lock(tx);
        const current = (
          await tx.query<{
            provider_snapshot_id: string | null;
            provider_sandbox_id: string | null;
            org_id: string;
            owner_id: string;
            visibility: string;
          }>(
            "select provider_snapshot_id,provider_sandbox_id,org_id,owner_id,visibility from goldens where id=$1 for update",
            [golden.id],
          )
        ).rows[0];
        if (
          !current ||
          current.provider_snapshot_id !== golden.providerSnapshotId ||
          current.provider_sandbox_id !== golden.providerSandboxId ||
          current.org_id !== golden.orgId ||
          current.owner_id !== golden.ownerId ||
          current.visibility !== golden.visibility
        )
          throw new GoldenError("conflict", "Golden revision changed before snapshot save.");
        const member = (
          await tx.query<{ role: string }>("select role from members where org_id=$1 and user_id=$2 for share", [
            actor.orgId,
            actor.userId,
          ])
        ).rows[0];
        if (
          !member ||
          (golden.visibility === "org" && member.role !== "admin") ||
          (golden.visibility === "private" && golden.ownerId !== actor.userId)
        )
          throw new GoldenError("forbidden", "Snapshot authority changed.");
        await options.job?.lock(tx);
        if (
          golden.provider === "boat" &&
          !(
            await tx.query(
              "select 1 from golden_backend_slots where golden_id=$1 and provider='boat' and backend_id=$2",
              [golden.id, backend],
            )
          ).rows.length
        )
          throw new GoldenError("conflict", "Revision backend binding changed.");
        await tx.query(
          `insert into public.golden_snapshot_publications(id,golden_id,provider,backend_id,snapshot,source_id,authority,target,manager_id,job_id,proven)
          values($1,$2,$3,$4,$5,$6,$7::text::jsonb,$8::text::jsonb,$9,$10,false)`,
          [
            crypto.randomUUID(),
            golden.id,
            golden.provider,
            backend,
            name,
            builderId,
            JSON.stringify(authority),
            JSON.stringify(target),
            actor.userId,
            options.job?.id ?? null,
          ],
        );
      });
      try {
        await provider.getSnapshot(name);
      } catch (error) {
        if (error instanceof ProviderError && error.code === "not_found") return;
        throw error;
      }
      throw new GoldenError("conflict", "Rebuild saved label already exists; no snapshot was overwritten.");
    },
    async canDiscardSnapshot(snapshot, error) {
      return typeof error === "object" && error !== null && rolledBack.get(error) === snapshot;
    },
    async persist({
      actor,
      provider,
      modal,
      existingGolden,
      name,
      visibility,
      repos,
      init,
      snapshot,
      builderId,
      reservationId,
      warnings,
      helperReceipt,
    }) {
      const config: GoldenConfig = {
        repos: repos.map(
          (repo): GoldenRepo => ({
            url: `https://github.com/${repo.owner}/${repo.repo}.git`,
            branch: repo.branch ?? "main",
            dir: repo.dir,
          }),
        ),
        init,
      };
      const target = {
        provider,
        orgId: actor.orgId,
        ownerId: existingGolden?.ownerId ?? actor.userId,
        visibility,
        modal,
      };
      const publication = buildProvider
        ? await captureGoldenPublication(
            buildProvider,
            actor,
            target,
            existingGolden?.id ?? crypto.randomUUID(),
            snapshot,
            builderId,
            options.job?.id,
          )
        : undefined;
      const predecessor =
        buildProvider && existingGolden?.providerSnapshotId
          ? await captureHistoricalPublication(
              options.sql,
              options.github.encryptionKey,
              buildProvider,
              actor,
              target,
              existingGolden.id,
              existingGolden.providerSnapshotId,
            )
          : null;
      let step = "transaction";
      const persist = async (sql: Sql) => {
        step = "lease_fence";
        await options.job?.lock(sql);
        step = "golden_metadata";
        const transactionalStore = createSqlGoldenStore(sql);
        const inserted = existingGolden
          ? existingGolden
          : await transactionalStore.insert({
              orgId: actor.orgId,
              name,
              visibility,
              ownerId: actor.userId,
              provider,
              modal,
              config,
            });
        if (existingGolden) {
          const current = await sql.query<{
            provider_snapshot_id: string | null;
            provider_sandbox_id: string | null;
            owner_id: string;
            visibility: string;
            org_id: string;
          }>(
            "select provider_snapshot_id,provider_sandbox_id,owner_id,visibility,org_id from public.goldens where id=$1 for update",
            [inserted.id],
          );
          if (
            current.rows[0]?.provider_snapshot_id !== existingGolden.providerSnapshotId ||
            current.rows[0]?.provider_sandbox_id !== existingGolden.providerSandboxId ||
            current.rows[0]?.owner_id !== existingGolden.ownerId ||
            current.rows[0]?.visibility !== existingGolden.visibility ||
            current.rows[0]?.org_id !== existingGolden.orgId
          )
            throw new GoldenError("conflict", "Golden changed during rebuild. Retry from its current revision.");
        }
        // Null master + ready snapshot is the durable restore-on-connect strategy. Never point
        // at the disposable builder, which the service always stops after this transaction.
        step = "snapshot_pointer";
        await sql.query("update public.goldens set provider_sandbox_id=null,boat_sandbox_id=null where id=$1", [
          inserted.id,
        ]);
        if (existingGolden) {
          step = "golden_metadata";
          await transactionalStore.setConfig(inserted.id, config);
        }
        step = "snapshot_pointer";
        await transactionalStore.setSnapshot(inserted.id, snapshot);
        if (publication) {
          publication.golden_id = inserted.id;
          const duplicate = await sql.query<{ source_id: string | null; proven: boolean; golden_id: string }>(
            "select source_id,proven,golden_id from public.golden_snapshot_publications where provider=$1 and backend_id=$2 and snapshot=$3",
            [provider, publication.backend_id, snapshot],
          );
          if (
            duplicate.rows.length &&
            (duplicate.rows[0]?.proven ||
              duplicate.rows[0]?.source_id !== builderId ||
              duplicate.rows[0]?.golden_id !== inserted.id)
          )
            throw new GoldenError("conflict", "Saved revision names cannot be reused.");
          const next = await recordGoldenPublication(sql, publication);
          if (existingGolden?.providerSnapshotId) {
            // Old immutable provenance is evidence for the collector, not a reason to
            // fail a valid replacement if an old upstream artifact has since changed.
            const known = (
              await sql.query<Awaited<ReturnType<typeof recordGoldenPublication>>>(
                "select * from public.golden_snapshot_publications where provider=$1 and backend_id=$2 and snapshot=$3",
                [provider, publication.backend_id, existingGolden.providerSnapshotId],
              )
            ).rows[0];
            const old = known?.proven
              ? known
              : await recordGoldenPublication(
                  sql,
                  predecessor ?? {
                    ...publication,
                    id: crypto.randomUUID(),
                    snapshot: existingGolden.providerSnapshotId,
                    source_id: null,
                    artifact_id: null,
                    proven: false,
                    job_id: null,
                  },
                );
            await enqueueGoldenRetirement(sql, old, next);
          }
        }
        // This update is inside the same database transaction as the golden metadata. A failed
        // finalize rolls everything back; the service can safely release only the still-pending slot.
        step = "slot_finalize";
        if (reservationId) await sqlGoldenBackendSlots(sql).finalize(reservationId, inserted.id);
        step = "job_complete";
        await sql.query("update public.goldens set build_warnings=$2::text[] where id=$1", [
          inserted.id,
          "{" + warnings.join(",") + "}",
        ]);
        await sql.query("update public.goldens set helper_receipt=$2::text::jsonb where id=$1", [
          inserted.id,
          JSON.stringify(helperReceipt ?? null),
        ]);
        await options.job?.complete(sql, inserted.id, snapshot, warnings);
        step = "commit";
        return inserted.id;
      };
      if (!options.sql.transaction) throw new GoldenError("conflict", "Atomic golden persistence is unavailable.");
      let callbackFailed = false;
      let callbackError: unknown;
      try {
        return await options.sql.transaction(async (tx) => {
          try {
            return await persist(tx);
          } catch (error) {
            callbackFailed = true;
            callbackError = error;
            throw error;
          }
        });
      } catch (error) {
        // Sql.transaction's contract acknowledges rollback before rejecting a callback failure.
        // No callback failure means COMMIT may still be in flight, regardless of any later read.
        const knownRollback = callbackFailed && error === callbackError && typeof error === "object" && error !== null;
        if (knownRollback) rolledBack.set(error, snapshot);
        const databaseError = error && typeof error === "object" ? (error as { code?: unknown; errno?: unknown }) : {};
        // Bun wraps SQLSTATE in errno; pg/PGlite expose it in code. Never log message,
        // detail, constraint, query, parameters, or the error object itself.
        const state = databaseError.code === "ERR_POSTGRES_SERVER_ERROR" ? databaseError.errno : databaseError.code;
        const knownStates = [
          "08003",
          "08006",
          "22001",
          "22003",
          "22023",
          "22P02",
          "23502",
          "23503",
          "23505",
          "23514",
          "40001",
          "40P01",
          "42501",
          "42703",
          "42804",
          "42883",
          "42P01",
          "42P08",
          "53300",
          "53400",
          "55000",
          "57014",
          "57P01",
          "P0001",
          "P0002",
          "XX000",
        ];
        const sqlState = typeof state === "string" && knownStates.includes(state) ? state : "unavailable";
        console.error(
          JSON.stringify({
            event: "golden_persist_failed",
            ...(options.job ? { buildId: options.job.id } : {}),
            step,
            sqlState,
          }),
        );
        if (error instanceof GoldenError) throw error;
        if (sqlState !== "unavailable") {
          const safe = new GoldenError(
            "build_failed",
            `Golden publication failed (${sqlState}); reconcile publication before retrying.`,
          );
          if (knownRollback) rolledBack.set(safe, snapshot);
          throw safe;
        }
        throw error;
      }
    },
  };
  if (options.job)
    deps.execution = {
      id: options.job.id,
      phase: options.job.phase,
      builder: options.job.builder,
      cleaned: options.job.cleaned,
    };
  if (adapter.mint) deps.mint = adapter.mint;
  return new GoldenCreateService(deps);
}

/** Reserve on the caller's transaction so durable admission and capacity commit together. */
export async function reserveGoldenBuild(
  sql: Sql,
  provider: Provider,
  actor: GoldenActor,
  existingGolden?: GoldenRecord,
  slots: GoldenBackendSlot = sqlGoldenBackendSlots(sql),
  defaultCapacity?: number,
): Promise<string | undefined> {
  const capacity = provider.maxGoldens ?? defaultCapacity ?? (provider.id === "boat" ? 1 : undefined);
  if (capacity === undefined) return undefined;
  if (!Number.isInteger(capacity) || capacity < 1)
    throw new GoldenError("invalid_config", "Provider golden capacity must be a positive integer.");
  if (!provider.backendIdentity) throw new GoldenError("forbidden", "Provider cannot verify its backend identity.");
  const identity = await provider.backendIdentity();
  if (!identity?.id) throw new GoldenError("forbidden", "Provider returned no backend identity.");
  if (existingGolden) {
    await assertGoldenBackendBinding(sql, existingGolden, provider, identity.id);
    return slots.reserveExisting({
      provider: provider.id,
      backendId: identity.id,
      capacity,
      goldenId: existingGolden.id,
    });
  }
  return slots.reserve({
    provider: provider.id,
    backendId: identity.id,
    capacity,
    orgId: actor.orgId,
    ownerId: actor.userId,
  });
}

const BACKEND_CONFLICT_MESSAGE =
  "Golden capacity or binding is unavailable or busy. Use an existing golden you can access, retry after any active build finishes, or ask an administrator to check the binding.";

/** Match only errors owned by the slot protocol. Bun puts SQLSTATE in errno; pg/PGlite use code.
 * Do not classify arbitrary P0001 raises, unique violations, provider errors, or SQL outages. */
async function backendSlotQuery<T>(sql: Sql, query: string, params: unknown[]): Promise<{ rows: T[] }> {
  try {
    return await sql.query<T>(query, params);
  } catch (error) {
    if (error && typeof error === "object") {
      const e = error as {
        code?: string;
        errno?: string;
        message?: string;
        constraint?: string;
        table?: string;
        schema?: string;
      };
      const state = e.code === "ERR_POSTGRES_SERVER_ERROR" ? e.errno : e.code;
      const knownRaise =
        state === "P0001" &&
        (e.message === "golden backend capacity reached" || e.message === "golden backend build already in progress");
      const knownConstraint =
        state === "23505" &&
        e.schema === "public" &&
        e.table === "golden_backend_slots" &&
        (e.constraint === "golden_backend_one_binding" || e.constraint === "boat_backend_one_slot");
      if (knownRaise || knownConstraint) throw new GoldenError("conflict", BACKEND_CONFLICT_MESSAGE);
    }
    throw error;
  }
}

/** Service-role wrapper around the database reservation functions. */
export function sqlGoldenBackendSlots(sql: Sql): GoldenBackendSlot {
  return {
    async reserve(input) {
      const result = await backendSlotQuery<{ reserve_golden_backend_slot: string }>(
        sql,
        "select public.reserve_golden_backend_slot($1, $2, $3, $4::uuid, $5::uuid)",
        [input.provider, input.backendId, input.capacity, input.orgId, input.ownerId],
      );
      const id = result.rows[0]?.reserve_golden_backend_slot;
      if (!id) throw new GoldenError("conflict", BACKEND_CONFLICT_MESSAGE);
      return id;
    },
    async reserveExisting(input) {
      const result = await backendSlotQuery<{ reserve_existing_golden_backend_slot: string }>(
        sql,
        "select public.reserve_existing_golden_backend_slot($1, $2, $3, $4::uuid)",
        [input.provider, input.backendId, input.capacity, input.goldenId],
      );
      const id = result.rows[0]?.reserve_existing_golden_backend_slot;
      if (!id) throw new GoldenError("conflict", BACKEND_CONFLICT_MESSAGE);
      return id;
    },
    async finalize(reservationId, goldenId) {
      await backendSlotQuery(sql, "select public.finalize_golden_backend_slot($1::uuid, $2::uuid)", [
        reservationId,
        goldenId,
      ]);
    },
    async release(reservationId) {
      await sql.query("select public.release_golden_backend_slot($1::uuid)", [reservationId]);
    },
  };
}

/** Fail closed: existing mutations never claim a new account slot or adopt a legacy golden. */
export async function assertGoldenBackendBinding(
  sql: Sql,
  golden: GoldenRecord,
  provider: Provider,
  backendId?: string,
): Promise<void> {
  if (golden.provider !== "boat" && provider.maxGoldens === undefined) return;
  const identity = backendId ?? (await provider.backendIdentity?.())?.id;
  if (!identity) throw new GoldenError("conflict", "Golden backend binding cannot be verified.");
  const result = await sql.query<{ busy: boolean }>(
    `select build_id is not null as busy from public.golden_backend_slots
     where provider = $1 and backend_id = $2 and golden_id = $3::uuid`,
    [golden.provider, identity, golden.id],
  );
  if (result.rows.length !== 1 || result.rows[0]?.busy) throw new GoldenError("conflict", BACKEND_CONFLICT_MESSAGE);
}
