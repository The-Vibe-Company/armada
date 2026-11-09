import { createHash, randomUUID } from "node:crypto";
import { decryptSecret } from "./crypto.ts";
import type { GoldenActor, GoldenRecord } from "./golden.ts";
import { GoldenError } from "./golden-config.ts";
import { assertSqlGoldenMutation, type GoldenRow, mapGoldenRow, type Sql } from "./golden-store.ts";
import { isNonMutatingProviderRefusal, type Provider, ProviderError } from "./provider.ts";
import type { ProviderTarget, SandboxProviderId } from "./sandbox-provider.ts";

interface Target extends ProviderTarget {
  ownerId: string;
}
interface Proof {
  id: string;
  golden_id: string;
  provider: SandboxProviderId;
  backend_id: string;
  snapshot: string;
  source_id: string | null;
  artifact_id: string | null;
  authority: { scope: "org" | "user"; ownerId: string } | null;
  target: Target;
  manager_id: string;
  job_id: string | null;
  proven: boolean;
}
interface Candidate {
  id: string;
  golden_id: string;
  provider: SandboxProviderId;
  backend_id: string;
  old_snapshot: string;
  new_snapshot: string;
  publication_id: string;
  replacement_id: string;
  state: string;
  sealed: boolean;
  delete_started: boolean;
  claim_id: string | null;
}
interface ReviewProof {
  goldenId: string;
  provider: SandboxProviderId;
  currentSnapshot: string;
  currentArtifact: { sourceId: string; artifactId: string; jobId: string | null };
  backendId: string;
  authority: NonNullable<Proof["authority"]>;
  old: { snapshot: string; sourceId: string; artifactId: string; jobId: string | null };
  replacement: { snapshot: string; sourceId: string; artifactId: string; jobId: string | null };
  target: Target;
}
type Report = {
  receipt?: string;
  proof?: ReviewProof;
  oldSnapshot?: string;
  newSnapshot?: string;
  outcome: "eligible" | "protected" | "deferred";
  reason: string;
};
const notFound = (e: unknown) => e instanceof ProviderError && e.code === "not_found";
const canonical = (value: unknown): unknown =>
  value && typeof value === "object"
    ? Array.isArray(value)
      ? value.map(canonical)
      : Object.fromEntries(
          Object.entries(value)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([k, v]) => [k, canonical(v)]),
        )
    : value;
const same = (a: unknown, b: unknown) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
const identityMatches = (a: Proof["authority"], b: Proof["authority"]) =>
  a?.scope === b?.scope && a?.ownerId === b?.ownerId;
const targetMatches = (a: Target, b: Target) =>
  a.provider === b.provider &&
  a.orgId === b.orgId &&
  a.ownerId === b.ownerId &&
  a.visibility === b.visibility &&
  same(a.modal, b.modal);

/** Read-only provider facts; unknown provenance must not turn a committed rebuild into failure. */
export async function captureGoldenPublication(
  provider: Provider,
  actor: GoldenActor,
  target: Target,
  goldenId: string,
  snapshot: string,
  builderId: string,
  jobId?: string,
): Promise<Proof> {
  const proof: Proof = {
    id: randomUUID(),
    golden_id: goldenId,
    provider: target.provider,
    backend_id: "unverified",
    snapshot,
    source_id: null,
    artifact_id: null,
    authority: null,
    target,
    manager_id: actor.userId,
    job_id: jobId ?? null,
    proven: false,
  };
  try {
    const backend = await provider.backendIdentity?.();
    const authority = await provider.managementIdentity?.();
    if (backend?.id) proof.backend_id = backend.id;
    if (authority) proof.authority = authority;
    const info = await provider.getSnapshot(snapshot);
    if (info.name === snapshot && info.status === "ready" && info.sourceSandboxId === builderId && info.artifactId) {
      proof.source_id = builderId;
      proof.artifact_id = info.artifactId;
      proof.proven =
        provider.id === target.provider &&
        !!backend?.id &&
        !!authority &&
        ((authority.scope === "org" && authority.ownerId === target.orgId) ||
          (target.visibility === "private" && authority.scope === "user" && authority.ownerId === target.ownerId)) &&
        (provider.id !== "modal" || identityMatches(info.managementAuthority ?? null, authority));
    }
  } catch {
    /* An unavailable collector prerequisite retains the revision. */
  }
  return proof;
}

/** Legacy proofs require a singleton succeeded job, exact source and org-only immutable authority.
 * Private pre-provenance credential selection cannot be reconstructed and is intentionally retained. */
export async function captureHistoricalPublication(
  sql: Sql,
  key: string | undefined,
  provider: Provider,
  actor: GoldenActor,
  target: Target,
  goldenId: string,
  snapshot: string,
): Promise<Proof | null> {
  try {
    if (target.visibility !== "org") return null;
    const rows = (
      await sql.query<{
        id: string;
        builder_id: string | null;
        owner_id: string;
        payload_enc: Uint8Array<ArrayBuffer>;
      }>(
        "select id,builder_id,owner_id,payload_enc from public.golden_build_jobs where golden_id=$1 and org_id=$2 and visibility='org' and provider=$3 and state='succeeded' and snapshot=$4 limit 2",
        [goldenId, target.orgId, target.provider, snapshot],
      )
    ).rows;
    if (rows.length !== 1 || !rows[0]?.builder_id) return null;
    const j = rows[0],
      input = JSON.parse(await decryptSecret(j.payload_enc, key));
    if (
      (input.provider ?? "boat") !== target.provider ||
      input.visibility !== target.visibility ||
      !same(input.modal ?? null, target.modal)
    )
      return null;
    const old = input.existingGolden;
    if (old === undefined || (old !== null && typeof old !== "object")) return null;
    if (
      old &&
      (old.id !== goldenId ||
        old.orgId !== target.orgId ||
        old.ownerId !== target.ownerId ||
        old.visibility !== target.visibility ||
        old.provider !== target.provider ||
        !same(old.modal ?? null, target.modal))
    )
      return null;
    const proof = await captureGoldenPublication(
      provider,
      { ...actor, userId: j.owner_id },
      target,
      goldenId,
      snapshot,
      j.builder_id!,
      j.id,
    );
    if (!proof.proven || proof.authority?.scope !== "org" || proof.authority.ownerId !== target.orgId) return null;
    if (
      target.provider === "boat" &&
      !(
        await sql.query(
          "select 1 from public.golden_backend_slots where golden_id=$1 and provider='boat' and backend_id=$2",
          [goldenId, proof.backend_id],
        )
      ).rows.length
    )
      return null;
    return proof;
  } catch {
    return null;
  }
}

export async function recordGoldenPublication(sql: Sql, proof: Proof): Promise<Proof> {
  const existing = (
    await sql.query<Proof>(
      "select * from public.golden_snapshot_publications where provider=$1 and backend_id=$2 and snapshot=$3",
      [proof.provider, proof.backend_id, proof.snapshot],
    )
  ).rows[0];
  if (existing) {
    if (
      proof.proven &&
      existing.proven &&
      (existing.golden_id !== proof.golden_id ||
        existing.source_id !== proof.source_id ||
        existing.artifact_id !== proof.artifact_id ||
        !identityMatches(existing.authority, proof.authority) ||
        !targetMatches(existing.target, proof.target))
    )
      throw new GoldenError("conflict", "Publication fingerprint is immutable.");
    if (
      proof.proven &&
      !existing.proven &&
      targetMatches(existing.target, proof.target) &&
      (!existing.source_id || existing.source_id === proof.source_id)
    ) {
      return (
        (
          await sql.query<Proof>(
            `update public.golden_snapshot_publications set source_id=$2,artifact_id=$3,authority=$4::text::jsonb,proven=true,manager_id=$5,job_id=$6 where id=$1 and not proven returning *`,
            [
              existing.id,
              proof.source_id,
              proof.artifact_id,
              JSON.stringify(proof.authority),
              proof.manager_id,
              proof.job_id,
            ],
          )
        ).rows[0] ?? existing
      );
    }
    return existing;
  }
  return (
    await sql.query<Proof>(
      `insert into public.golden_snapshot_publications
    (id,golden_id,provider,backend_id,snapshot,source_id,artifact_id,authority,target,manager_id,job_id,proven)
    values($1,$2,$3,$4,$5,$6,$7,$8::text::jsonb,$9::text::jsonb,$10,$11,$12) returning *`,
      [
        proof.id,
        proof.golden_id,
        proof.provider,
        proof.backend_id,
        proof.snapshot,
        proof.source_id,
        proof.artifact_id,
        JSON.stringify(proof.authority),
        JSON.stringify(proof.target),
        proof.manager_id,
        proof.job_id,
        proof.proven,
      ],
    )
  ).rows[0]!;
}
/** Called ONLY on the publication transaction, before its slot/job-success commit. */
export async function enqueueGoldenRetirement(
  sql: Sql,
  old: Proof,
  next: Proof,
  review?: { receipt: string; userId: string },
): Promise<void> {
  if (old.snapshot === next.snapshot) throw new GoldenError("conflict", "Saved revision names cannot be reused.");
  await sql.query(
    `insert into public.golden_snapshot_retirements
    (golden_id,provider,backend_id,old_snapshot,new_snapshot,publication_id,replacement_id,review_receipt,reviewed_by)
    values($1,$2,$3,$4,$5,$6,$7,$8,$9) on conflict(provider,backend_id,old_snapshot) do update
    set review_receipt=coalesce(golden_snapshot_retirements.review_receipt,excluded.review_receipt),
      reviewed_by=coalesce(golden_snapshot_retirements.reviewed_by,excluded.reviewed_by)
    where not golden_snapshot_retirements.sealed and golden_snapshot_retirements.new_snapshot=excluded.new_snapshot
      and golden_snapshot_retirements.publication_id=excluded.publication_id and golden_snapshot_retirements.replacement_id=excluded.replacement_id`,
    [
      next.golden_id,
      next.provider,
      next.backend_id,
      old.snapshot,
      next.snapshot,
      old.id,
      next.id,
      review?.receipt ?? null,
      review?.userId ?? null,
    ],
  );
}

export interface GoldenSnapshotRetirementOptions {
  sql: Sql;
  encryptionKey: string | undefined;
  /** Resolve only the persisted source authority. Must not create an App, VM or builder. */
  provider(actor: GoldenActor, target: ProviderTarget): Promise<Provider>;
}
/** Service-owned outbox; unknown provider outcomes are readback-only, never lease-expiry replays. */
export class GoldenSnapshotRetirements {
  constructor(private readonly options: GoldenSnapshotRetirementOptions) {}
  private transaction<T>(work: (sql: Sql) => Promise<T>) {
    if (!this.options.sql.transaction) throw new GoldenError("conflict", "Retirement transactions unavailable.");
    return this.options.sql.transaction(work);
  }
  private async actor(proof: Proof): Promise<GoldenActor> {
    const m = (
      await this.options.sql.query<{ role: "admin" | "member" }>(
        "select role from public.members where org_id=$1 and user_id=$2",
        [proof.target.orgId, proof.manager_id],
      )
    ).rows[0];
    if (
      !m ||
      (proof.target.visibility === "org" && m.role !== "admin") ||
      (proof.target.visibility === "private" && proof.manager_id !== proof.target.ownerId)
    )
      throw new GoldenError("forbidden", "Retirement authority unavailable.");
    return { orgId: proof.target.orgId, userId: proof.manager_id, role: m.role };
  }
  async forCaller(
    userId: string,
    orgIds: string[],
    goldenId: string,
    limit: number,
    enqueue = false,
    receipts: string[] = [],
  ) {
    const r = (
      await this.options.sql.query<GoldenRow & { role: "admin" | "member" }>(
        `select g.*,m.role from public.goldens g join public.members m on m.org_id=g.org_id and m.user_id=$2
      where g.id=$1::uuid and g.org_id=any($3::uuid[]) and (g.visibility='org' or g.owner_id=$2)`,
        [goldenId, userId, orgIds],
      )
    ).rows[0];
    if (!r) throw new GoldenError("not_found", "No such golden.");
    return this.reconcile({ userId, orgId: r.org_id, role: r.role }, mapGoldenRow(r), limit, enqueue, receipts);
  }
  private async protection(sql: Sql, c: Candidate): Promise<string | null> {
    if (
      (
        await sql.query("select 1 from public.goldens where provider::text=$1 and provider_snapshot_id=$2 limit 1", [
          c.provider,
          c.old_snapshot,
        ])
      ).rows.length
    )
      return "referenced";
    if (
      (
        await sql.query(
          `select 1 from public.golden_operation_fences f join public.goldens g on g.id=f.golden_id
      where f.golden_id=$1 or (g.provider::text=$2 and (f.expected_snapshot_id=$3 or f.expected_snapshot_id is null)) limit 1`,
          [c.golden_id, c.provider, c.old_snapshot],
        )
      ).rows.length
    )
      return "operation_unresolved";
    if (
      (
        await sql.query("select 1 from public.golden_backend_slots where golden_id=$1 and build_id is not null", [
          c.golden_id,
        ])
      ).rows.length
    )
      return "build_unresolved";
    if (
      (
        await sql.query(
          `select 1 from public.golden_build_jobs where provider=$1 and state in ('queued','running','recovery_required')
      and (golden_id=$2 or expected_snapshot_id=$3 or expected_snapshot_id is null) limit 1`,
          [c.provider, c.golden_id, c.old_snapshot],
        )
      ).rows.length
    )
      return "build_unresolved";
    return null;
  }
  private async inspect(
    c: Candidate,
    proof: Proof,
    signal: AbortSignal = new AbortController().signal,
    reviewCurrent?: Proof,
  ): Promise<{ provider: Provider; absent: boolean; currentSnapshot: string } | string> {
    if (
      proof.golden_id !== c.golden_id ||
      proof.provider !== c.provider ||
      !proof.proven ||
      !proof.source_id ||
      !proof.artifact_id ||
      !proof.authority ||
      proof.backend_id !== c.backend_id ||
      proof.snapshot !== c.old_snapshot
    )
      return "provenance_unavailable";
    const g = (
      await this.options.sql.query<{
        org_id: string;
        owner_id: string;
        visibility: "org" | "private";
        provider: SandboxProviderId;
        provider_snapshot_id: string | null;
        modal_workspace: string | null;
        modal_environment: string | null;
        modal_app_id: string | null;
      }>("select * from public.goldens where id=$1", [c.golden_id])
    ).rows[0];
    if (
      !g ||
      !targetMatches(proof.target, {
        provider: g.provider,
        orgId: g.org_id,
        ownerId: g.owner_id,
        visibility: g.visibility,
        modal:
          g.provider === "modal"
            ? { workspace: g.modal_workspace!, environment: g.modal_environment!, appId: g.modal_app_id! }
            : null,
      })
    )
      return "target_changed";
    const read = async <T>(work: () => Promise<T>): Promise<T> => {
      signal.throwIfAborted();
      const value = await work();
      signal.throwIfAborted();
      return value;
    };
    const actor = await this.actor(proof);
    const provider = await read(() => this.options.provider(actor, proof.target));
    if (
      provider.id !== c.provider ||
      (await read(() => provider.backendIdentity?.() ?? Promise.resolve(undefined)))?.id !== c.backend_id ||
      !identityMatches(
        (await read(() => provider.managementIdentity?.() ?? Promise.resolve(undefined))) ?? null,
        proof.authority,
      )
    )
      return "authority_changed";
    if (
      c.provider === "boat" &&
      !(
        await this.options.sql.query(
          "select 1 from public.golden_backend_slots where provider=$1 and backend_id=$2 and golden_id=$3",
          [c.provider, c.backend_id, c.golden_id],
        )
      ).rows.length
    )
      return "binding_changed";
    // Loss of the current last-good artifact must not consume its last recoverable predecessor.
    if (!g.provider_snapshot_id) return "current_unavailable";
    const recordedCurrent = (
      await this.options.sql.query<Proof>(
        "select * from public.golden_snapshot_publications where provider=$1 and backend_id=$2 and snapshot=$3",
        [c.provider, c.backend_id, g.provider_snapshot_id],
      )
    ).rows[0];
    const currentProof = recordedCurrent?.proven ? recordedCurrent : reviewCurrent;
    if (
      !currentProof?.proven ||
      currentProof.snapshot !== g.provider_snapshot_id ||
      currentProof.golden_id !== c.golden_id ||
      currentProof.backend_id !== c.backend_id ||
      !identityMatches(currentProof.authority, proof.authority) ||
      !targetMatches(currentProof.target, proof.target)
    )
      return "current_provenance_unavailable";
    const currentInfo = await read(() => provider.getSnapshot(g.provider_snapshot_id!));
    if (
      currentInfo.name !== g.provider_snapshot_id ||
      currentInfo.status !== "ready" ||
      currentInfo.sourceSandboxId !== currentProof.source_id ||
      currentInfo.artifactId !== currentProof.artifact_id ||
      (c.provider === "modal" && !identityMatches(currentInfo.managementAuthority ?? null, currentProof.authority))
    )
      return "current_fingerprint_changed";
    try {
      const info = await read(() => provider.getSnapshot(c.old_snapshot));
      if (
        info.name !== c.old_snapshot ||
        info.status !== "ready" ||
        info.sourceSandboxId !== proof.source_id ||
        info.artifactId !== proof.artifact_id ||
        (c.provider === "modal" && !identityMatches(info.managementAuthority ?? null, proof.authority))
      )
        return "fingerprint_changed";
    } catch (e) {
      if (notFound(e)) return { provider, absent: true, currentSnapshot: g.provider_snapshot_id };
      throw e;
    }
    try {
      if ((await read(() => provider.get(proof.source_id!))).state !== "stopped") return "source_active";
    } catch (e) {
      if (!notFound(e)) throw e;
    }
    return { provider, absent: false, currentSnapshot: g.provider_snapshot_id };
  }
  async runOne(signal: AbortSignal = new AbortController().signal): Promise<boolean> {
    if (signal.aborted) return false;
    const sql = this.options.sql;
    const pending = (
      await sql.query<Candidate>(`select * from public.golden_snapshot_retirements where state<>'retired'
      and next_attempt_at<=clock_timestamp() and (claim_until is null or claim_until<=clock_timestamp()) order by next_attempt_at,id limit 1`)
    ).rows[0];
    if (!pending) return false;
    const claim = randomUUID();
    const row = await this.transaction(async (tx) => {
      await tx.query("select id from public.goldens where id=$1 for update", [pending.golden_id]);
      const c = (
        await tx.query<Candidate>(
          `select * from public.golden_snapshot_retirements where id=$1 and state<>'retired'
        and (claim_until is null or claim_until<=clock_timestamp()) for update skip locked`,
          [pending.id],
        )
      ).rows[0];
      if (!c) return null;
      const proof = (
        await tx.query<Proof>("select * from public.golden_snapshot_publications where id=$1", [c.publication_id])
      ).rows[0];
      const replacement = (
        await tx.query<Proof>("select * from public.golden_snapshot_publications where id=$1", [c.replacement_id])
      ).rows[0];
      if (
        proof?.golden_id !== c.golden_id ||
        proof?.provider !== c.provider ||
        !proof?.proven ||
        !proof.source_id ||
        !proof.artifact_id ||
        !proof.authority ||
        !replacement?.proven ||
        !replacement.source_id ||
        !replacement.artifact_id ||
        replacement.snapshot !== c.new_snapshot ||
        replacement.backend_id !== c.backend_id ||
        replacement.provider !== c.provider ||
        replacement.golden_id !== c.golden_id ||
        !identityMatches(replacement.authority, proof.authority) ||
        !targetMatches(replacement.target, proof.target)
      ) {
        await tx.query(
          "update public.golden_snapshot_retirements set state='deferred',reason='provenance_unavailable',next_attempt_at=clock_timestamp()+interval '30 seconds' where id=$1",
          [c.id],
        );
        return null;
      }
      await tx.query("select public.lock_golden_snapshot($1,$2)", [c.provider, c.old_snapshot]);
      const protectedBy = await this.protection(tx, c);
      if (protectedBy) {
        await tx.query(
          "update public.golden_snapshot_retirements set state='deferred',reason=$2,next_attempt_at=clock_timestamp()+interval '30 seconds' where id=$1",
          [c.id, protectedBy],
        );
        return null;
      }
      await tx.query(
        `update public.golden_snapshot_retirements set sealed=true,claim_id=$2,claim_until=clock_timestamp()+interval '60 seconds',attempts=attempts+1 where id=$1`,
        [c.id, claim],
      );
      return c;
    });
    if (!row) return true;
    let started = row.delete_started;
    let deleting = false;
    const finish = async (state: string, reason: string, retryDelete = false) => {
      await sql.query(
        `update public.golden_snapshot_retirements set state=$3,reason=$4,claim_until=null,claim_id=null,
        delete_started=case when $5 then false else delete_started end,next_attempt_at=clock_timestamp()+interval '30 seconds'
        where id=$1 and claim_id=$2`,
        [row.id, claim, state, reason, retryDelete],
      );
    };
    try {
      const proof = (
        await sql.query<Proof>("select * from public.golden_snapshot_publications where id=$1", [row.publication_id])
      ).rows[0];
      if (!proof) {
        await finish("deferred", "provenance_unavailable");
        return true;
      }
      const checked = await this.inspect(row, proof, signal);
      if (typeof checked === "string") {
        await finish("deferred", checked);
        return true;
      }
      if (signal.aborted) {
        await finish(started ? "uncertain" : "deferred", "shutdown");
        return true;
      }
      if (checked.absent) {
        await finish("retired", "already_absent");
        return true;
      }
      if (started) {
        await finish("uncertain", "delete_outcome_unknown");
        return true;
      }
      // Permanent SQL barrier is already committed. All future pointer introductions are refused.
      const begun = await this.transaction(async (tx) => {
        const current = (
          await tx.query<GoldenRow>("select * from public.goldens where id=$1 for update", [row.golden_id])
        ).rows[0];
        if (
          !current ||
          current.provider_snapshot_id !== checked.currentSnapshot ||
          !targetMatches(proof.target, {
            provider: current.provider as SandboxProviderId,
            orgId: current.org_id,
            ownerId: current.owner_id,
            visibility: current.visibility as "org" | "private",
            modal:
              current.provider === "modal"
                ? {
                    workspace: current.modal_workspace!,
                    environment: current.modal_environment!,
                    appId: current.modal_app_id!,
                  }
                : null,
          })
        )
          return { rows: [] };
        const member = (
          await tx.query<{ role: string }>("select role from public.members where org_id=$1 and user_id=$2 for share", [
            proof.target.orgId,
            proof.manager_id,
          ])
        ).rows[0];
        if (
          !member ||
          (proof.target.visibility === "org" && member.role !== "admin") ||
          (await this.protection(tx, row))
        )
          return { rows: [] };
        return tx.query(
          "update public.golden_snapshot_retirements set delete_started=true where id=$1 and claim_id=$2 and claim_until>clock_timestamp() returning id",
          [row.id, claim],
        );
      });
      if (!begun.rows.length || signal.aborted) {
        await finish("deferred", "authority_or_reference_changed");
        return true;
      }
      started = true;
      deleting = true;
      await checked.provider.deleteSnapshot(row.old_snapshot);
      await finish("retired", "deleted");
    } catch (e) {
      if (deleting && notFound(e)) await finish("retired", "already_absent");
      else if (deleting && isNonMutatingProviderRefusal(e)) await finish("deferred", "provider_unavailable", true);
      else if (started) await finish("uncertain", "delete_outcome_unknown");
      else await finish("deferred", "provider_unavailable");
    }
    return true;
  }

  /** Bounded, owner/admin authorized historical chain reconstruction. No provider mutations. */
  async reconcile(
    actor: GoldenActor,
    golden: GoldenRecord,
    limit: number,
    enqueue = false,
    receipts: string[] = [],
  ): Promise<{ results: Report[] }> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 50)
      throw new GoldenError("invalid_config", "limit must be 1–50.");
    if (
      enqueue &&
      (!Array.isArray(receipts) ||
        !receipts.length ||
        receipts.length > 50 ||
        receipts.some((r) => typeof r !== "string" || !/^[a-f0-9]{64}$/.test(r)))
    )
      throw new GoldenError("invalid_config", "Reconcile requires reviewed receipts from dry-run.");
    const sql = this.options.sql;
    await assertSqlGoldenMutation(sql, golden, actor);
    const target: Target = {
      provider: golden.provider,
      orgId: golden.orgId,
      ownerId: golden.ownerId,
      visibility: golden.visibility,
      modal: golden.modal,
    };
    const provider = await this.options.provider(actor, target);
    const backend = (await provider.backendIdentity?.())?.id;
    const authority = await provider.managementIdentity?.();
    if (!backend || !authority) return { results: [{ outcome: "deferred", reason: "authority_unavailable" }] };
    // Private legacy history cannot prove whether the original build selected a user key or org fallback.
    if (golden.visibility !== "org" || authority.scope !== "org" || authority.ownerId !== golden.orgId)
      return { results: [{ outcome: "deferred", reason: "historical_authority_unproven" }] };
    if (
      golden.provider === "boat" &&
      !(
        await sql.query(
          "select 1 from public.golden_backend_slots where golden_id=$1 and provider='boat' and backend_id=$2",
          [golden.id, backend],
        )
      ).rows.length
    )
      return { results: [{ outcome: "deferred", reason: "binding_unavailable" }] };
    const canonicalProof = golden.providerSnapshotId
      ? await captureHistoricalPublication(
          sql,
          this.options.encryptionKey,
          provider,
          actor,
          target,
          golden.id,
          golden.providerSnapshotId,
        )
      : null;
    if (!canonicalProof?.proven)
      return { results: [{ outcome: "deferred", reason: "current_provenance_unavailable" }] };
    type Job = {
      id: string;
      golden_id: string;
      snapshot: string;
      builder_id: string;
      owner_id: string;
      payload_enc: Uint8Array<ArrayBuffer>;
    };
    const job = async (ref: string) => {
      const rows = (
        await sql.query<Job>(
          "select id,golden_id,snapshot,builder_id,owner_id,payload_enc from public.golden_build_jobs where golden_id=$1 and provider=$2 and state='succeeded' and snapshot=$3 and org_id=$4 and visibility=$5 limit 2",
          [golden.id, golden.provider, ref, golden.orgId, golden.visibility],
        )
      ).rows;
      if (rows.length !== 1 || !rows[0]?.builder_id) return null;
      const j = rows[0];
      const input = JSON.parse(await decryptSecret(j.payload_enc, this.options.encryptionKey));
      if (
        (input.provider ?? "boat") !== golden.provider ||
        input.visibility !== golden.visibility ||
        !same(input.modal ?? null, golden.modal)
      )
        return null;
      return { j, input };
    };
    const results: Report[] = [];
    let anchor = golden.providerSnapshotId;
    const seen = new Set<string>();
    while (anchor && results.length < limit) {
      seen.add(anchor);
      let successor: Awaited<ReturnType<typeof job>> = null;
      try {
        successor = await job(anchor);
      } catch {
        results.push({ outcome: "deferred", reason: "history_unavailable" });
        break;
      }
      const previous = successor?.input.existingGolden;
      if (!successor) {
        results.push({ newSnapshot: anchor, outcome: "deferred", reason: "successor_unproven" });
        break;
      }
      if (previous === null) break;
      if (!previous || typeof previous !== "object") {
        results.push({ newSnapshot: anchor, outcome: "deferred", reason: "history_conflict" });
        break;
      }
      const old = previous.providerSnapshotId;
      if (
        typeof old !== "string" ||
        seen.has(old) ||
        previous.id !== golden.id ||
        previous.orgId !== golden.orgId ||
        previous.ownerId !== golden.ownerId ||
        previous.visibility !== golden.visibility ||
        previous.provider !== golden.provider ||
        !same(previous.modal ?? null, golden.modal)
      ) {
        results.push({ outcome: "deferred", reason: "history_conflict" });
        break;
      }
      const report: Report = {
        oldSnapshot: old,
        newSnapshot: anchor,
        outcome: "deferred",
        reason: "predecessor_unproven",
      };
      try {
        const predecessor = await job(old);
        if (!predecessor) {
          results.push(report);
          break;
        }
        const oldProof = await captureGoldenPublication(
          provider,
          { ...actor, userId: predecessor.j.owner_id },
          target,
          golden.id,
          old,
          predecessor.j.builder_id,
          predecessor.j.id,
        );
        const nextProof = await captureGoldenPublication(
          provider,
          { ...actor, userId: successor.j.owner_id },
          target,
          golden.id,
          anchor,
          successor.j.builder_id,
          successor.j.id,
        );
        const candidate: Candidate = {
          id: "",
          golden_id: golden.id,
          provider: golden.provider,
          backend_id: backend,
          old_snapshot: old,
          new_snapshot: anchor,
          publication_id: oldProof.id,
          replacement_id: nextProof.id,
          state: "pending",
          sealed: false,
          delete_started: false,
          claim_id: null,
        };
        const prior = (
          await sql.query<Proof>(
            "select * from public.golden_snapshot_publications where provider=$1 and backend_id=$2 and snapshot=$3",
            [oldProof.provider, oldProof.backend_id, oldProof.snapshot],
          )
        ).rows[0];
        if (
          prior?.proven &&
          (prior.golden_id !== oldProof.golden_id ||
            prior.source_id !== oldProof.source_id ||
            prior.artifact_id !== oldProof.artifact_id ||
            !identityMatches(prior.authority, oldProof.authority))
        )
          report.reason = "fingerprint_changed";
        else if (!oldProof.proven || !nextProof.proven) report.reason = "fingerprint_unproven";
        else {
          const protect = await this.protection(sql, candidate);
          const inspect =
            protect ?? (await this.inspect(candidate, oldProof, new AbortController().signal, canonicalProof));
          if (typeof inspect === "string") {
            report.outcome = protect ? "protected" : "deferred";
            report.reason = inspect;
          } else if (inspect.absent) report.reason = "fingerprint_unproven";
          else if (inspect.currentSnapshot !== golden.providerSnapshotId) report.reason = "revision_changed";
          else {
            const review: ReviewProof = {
              goldenId: golden.id,
              provider: golden.provider,
              currentSnapshot: golden.providerSnapshotId!,
              currentArtifact: {
                sourceId: canonicalProof.source_id!,
                artifactId: canonicalProof.artifact_id!,
                jobId: canonicalProof.job_id,
              },
              backendId: backend,
              authority: oldProof.authority!,
              target,
              old: {
                snapshot: old,
                sourceId: oldProof.source_id!,
                artifactId: oldProof.artifact_id!,
                jobId: oldProof.job_id,
              },
              replacement: {
                snapshot: anchor,
                sourceId: nextProof.source_id!,
                artifactId: nextProof.artifact_id!,
                jobId: nextProof.job_id,
              },
            };
            report.receipt = createHash("sha256")
              .update(JSON.stringify(canonical(review)))
              .digest("hex");
            report.proof = review;
            report.outcome = "eligible";
            report.reason = "proven_chain";
            if (enqueue && !receipts.includes(report.receipt)) {
              report.outcome = "deferred";
              report.reason = "review_changed";
            }
          }
          if (enqueue && report.outcome === "eligible")
            await this.transaction(async (tx) => {
              const current = (
                await tx.query<{ provider_snapshot_id: string | null }>(
                  "select provider_snapshot_id from public.goldens where id=$1 for update",
                  [golden.id],
                )
              ).rows[0];
              if (current?.provider_snapshot_id !== golden.providerSnapshotId)
                throw new GoldenError("conflict", "Retirement review revision changed.");
              const member = (
                await tx.query<{ role: string }>(
                  "select role from public.members where org_id=$1 and user_id=$2 for share",
                  [actor.orgId, actor.userId],
                )
              ).rows[0];
              if (!member || member.role !== "admin")
                throw new GoldenError("forbidden", "Retirement authority changed.");
              await assertSqlGoldenMutation(tx, golden, actor);
              if (await this.protection(tx, candidate))
                throw new GoldenError("conflict", "Retirement references changed.");
              await recordGoldenPublication(tx, canonicalProof);
              await enqueueGoldenRetirement(
                tx,
                await recordGoldenPublication(tx, oldProof),
                await recordGoldenPublication(tx, nextProof),
                { receipt: report.receipt!, userId: actor.userId },
              );
            });
        }
      } catch {
        report.outcome = "deferred";
        report.reason = "history_unavailable";
      }
      results.push(report);
      anchor = old;
    }
    return { results };
  }
}
