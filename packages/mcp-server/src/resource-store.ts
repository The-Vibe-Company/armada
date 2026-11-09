import {
  GoldenError,
  LaunchError,
  mapSandboxRow,
  type ProviderResourceObservation,
  type SandboxRecord,
  type SandboxRow,
  type Sql,
} from "@armada/core";
import { validateProviderResourceObservation } from "../../core/src/resource-validation.ts";
import type { Caller } from "./caller.ts";

export interface ResourceHistory {
  target: SandboxRecord;
  targetObservation: { at: string; observation: ProviderResourceObservation } | null;
  sessions: {
    sandbox: SandboxRecord;
    observations: { at: string; activity: "unknown"; observation: ProviderResourceObservation }[];
  }[];
}
export interface ResourceStore {
  /** One atomic ten-second admission per sandbox, bound to its lifecycle generation. */
  claim(sandboxId: string, now: Date): Promise<string | null>;
  append(sandboxId: string, observation: ProviderResourceObservation, now: Date, admissionToken: string): Promise<void>;
  history(sandboxId: string, now: Date): Promise<ResourceHistory>;
}
interface ResourceRow extends SandboxRow {
  resource_sampling_token: string | null;
  resource_sampling_after: string | Date | null;
  resource_sampling_generation: string | number | bigint | null;
  activity_until: string | Date | null;
  reconcile_lease_until: string | Date | null;
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VISIBLE = `s.org_id=any($1::uuid[]) and exists(select 1 from public.members m where m.org_id=s.org_id and m.user_id=$2::uuid)
  and (s.visibility='org' or s.access_owner_id=$2::uuid)`;
function validNow(now: Date): string {
  if (!Number.isFinite(now.getTime())) throw new LaunchError("invalid_request", "Invalid observation time.");
  return now.toISOString();
}
const notFound = () => new GoldenError("not_found", "No such sandbox.");
const conflict = () => new GoldenError("conflict", "Observation does not match this physical session.");
/** Privileged SQL must recheck live visibility; scope is never accepted from observation payloads. */
export function createResourceStore(sql: Sql, caller: Caller): ResourceStore {
  const scope = [caller.orgs.map((org) => org.orgId), caller.userId];
  async function target(db: Sql, id: string, lock = false): Promise<ResourceRow> {
    if (!UUID.test(id)) throw notFound();
    const result = await db.query<ResourceRow>(
      `select s.*,s.lifecycle_generation::text as lifecycle_generation,
        s.resource_sampling_generation::text as resource_sampling_generation from public.sandboxes s where ${VISIBLE} and s.id=$3::uuid${lock ? " for update of s" : ""}`,
      [...scope, id],
    );
    const row = result.rows[0];
    if (!row) throw notFound();
    return row;
  }
  return {
    async claim(id, now) {
      const at = validNow(now);
      if (!UUID.test(id)) throw notFound();
      const token = crypto.randomUUID();
      const admitted = await sql.query<{ token: string }>(
        `update public.sandboxes s set resource_sampling_token=$4::uuid,
           resource_sampling_after=$5::timestamptz+interval '10 seconds',resource_sampling_generation=s.lifecycle_generation
         where ${VISIBLE} and s.id=$3::uuid and s.status in ('ready','running')
           and s.resource_project is not null and s.resource_project<>'null'::jsonb and s.machine_size->'capacity' is not null
           and s.machine_size->'capacity'<>'null'::jsonb
           and (s.resource_sampling_after is null or s.resource_sampling_after <= $5::timestamptz)
           and (s.activity_until is null or s.activity_until <= $5::timestamptz)
           and (s.reconcile_lease_until is null or s.reconcile_lease_until <= $5::timestamptz)
         returning s.resource_sampling_token::text as token`,
        [...scope, id, token, at],
      );
      if (admitted.rows[0]) return admitted.rows[0].token;
      // Hidden and nonexistent resources remain indistinguishable, unlike cooldown/busy/unknown.
      await target(sql, id);
      return null;
    },
    async append(id, observation, now, admissionToken) {
      const at = validNow(now);
      if (!UUID.test(admissionToken)) throw conflict();
      if (!sql.transaction) throw new GoldenError("conflict", "Atomic resource persistence is unavailable.");
      if (
        !validateProviderResourceObservation(observation) ||
        observation.reading.cpuLogicalCpus === null ||
        observation.reading.memoryTotalBytes === null ||
        Buffer.byteLength(JSON.stringify(observation)) > 16384
      )
        throw new LaunchError("invalid_request", "Invalid resource observation.");
      await sql.transaction(async (db) => {
        const row = await target(db, id, true);
        const replay = await db.query<{ same: boolean }>(
          `select o.observation=$5::text::jsonb as same from public.resource_observations o
           join public.sandboxes s on s.id=o.sandbox_id where ${VISIBLE} and s.id=$3::uuid and o.admission_token=$4::uuid`,
          [...scope, id, admissionToken, JSON.stringify(observation)],
        );
        if (replay.rows[0]) {
          if (!replay.rows[0].same) throw conflict();
          return;
        }
        if (
          row.resource_sampling_token !== admissionToken ||
          row.resource_sampling_generation === null ||
          row.lifecycle_generation === undefined ||
          String(row.resource_sampling_generation) !== String(row.lifecycle_generation) ||
          !row.resource_sampling_after ||
          now.getTime() >= new Date(row.resource_sampling_after).getTime() ||
          now.getTime() < new Date(row.resource_sampling_after).getTime() - 10000 ||
          (row.activity_until !== null && now.getTime() < new Date(row.activity_until).getTime()) ||
          (row.reconcile_lease_until !== null && now.getTime() < new Date(row.reconcile_lease_until).getTime())
        )
          throw conflict();
        if (
          observation.providerSandboxId !== row.provider_sandbox_id ||
          (row.provider === "boat"
            ? observation.runtimeProvenance !== "boat-dedicated-vm"
            : row.provider !== "modal" || observation.runtimeProvenance !== "modal-explicit-vm-v1")
        )
          throw conflict();
        if (!row.resource_project || !row.machine_size?.capacity || !["ready", "running"].includes(row.status))
          throw conflict();
        const previous = await db.query<{ observation: ProviderResourceObservation; observed_at: string | Date }>(
          `select o.observation,o.observed_at from public.resource_observations o join public.sandboxes s on s.id=o.sandbox_id
           where ${VISIBLE} and s.id=$3::uuid order by o.id desc limit 1`,
          [...scope, id],
        );
        const last = previous.rows[0];
        const existing = await db.query<{ id: string }>(
          `select o.id from public.resource_observations o join public.sandboxes s on s.id=o.sandbox_id
           where ${VISIBLE} and s.id=$3::uuid and o.physical_id=$4 and o.generation=$5 and o.boot_id=$6::uuid and o.uptime_ms=$7`,
          [
            ...scope,
            id,
            observation.physicalId,
            observation.generation,
            observation.reading.bootId,
            observation.reading.uptimeMs,
          ],
        );
        if (existing.rows.length) throw conflict();
        if (last) {
          if (now.getTime() < new Date(last.observed_at).getTime()) throw conflict();
          const prior = last.observation;
          const sameIncarnation =
            prior.physicalId === observation.physicalId &&
            prior.generation === observation.generation &&
            prior.reading.bootId === observation.reading.bootId;
          if (
            sameIncarnation &&
            (observation.reading.uptimeMs <= prior.reading.uptimeMs ||
              prior.reading.cpuLogicalCpus !== observation.reading.cpuLogicalCpus ||
              prior.reading.memoryTotalBytes !== observation.reading.memoryTotalBytes)
          )
            throw conflict();
          if (!sameIncarnation) {
            if (prior.generation === observation.generation) throw conflict();
            const seen = await db.query<{ id: string }>(
              `select o.id from public.resource_observations o join public.sandboxes s on s.id=o.sandbox_id
               where ${VISIBLE} and s.id=$3::uuid and o.physical_id=$4 and o.generation=$5 and o.boot_id=$6::uuid limit 1`,
              [...scope, id, observation.physicalId, observation.generation, observation.reading.bootId],
            );
            if (seen.rows.length) throw conflict();
          }
        }
        await db.query(
          `insert into public.resource_observations(sandbox_id,physical_id,generation,boot_id,uptime_ms,observed_at,observation,admission_token)
           select s.id,$4,$5,$6::uuid,$7,$8::timestamptz,$9::text::jsonb,$10::uuid from public.sandboxes s
           where ${VISIBLE} and s.id=$3::uuid`,
          [
            ...scope,
            id,
            observation.physicalId,
            observation.generation,
            observation.reading.bootId,
            observation.reading.uptimeMs,
            at,
            JSON.stringify(observation),
            admissionToken,
          ],
        );
        await db.query(
          `delete from public.resource_observations o using public.sandboxes s where o.sandbox_id=s.id and ${VISIBLE} and s.id=$3::uuid
           and (o.observed_at < $4::timestamptz-interval '14 days' or o.id not in (
             select r.id from public.resource_observations r where r.sandbox_id=s.id
             and r.observed_at >= $4::timestamptz-interval '14 days' order by r.id desc limit 720))`,
          [...scope, id, at],
        );
      });
    },
    async history(id, now) {
      const at = validNow(now);
      const selected = await target(sql, id);
      const selectedRecord = mapSandboxRow(selected);
      if (!selected.resource_project || !selected.machine_size?.capacity)
        return { target: selectedRecord, targetObservation: null, sessions: [] };
      const result = await sql.query<SandboxRow>(
        `select s.* from public.sandboxes s where ${VISIBLE} and s.owner_id=$3::uuid and s.org_id=$4::uuid
         and s.golden_id=$5::uuid and s.provider=$6::public.sandbox_provider and s.harness=$7::public.harness
         and s.model is not distinct from $8::text and s.reasoning_effort is not distinct from $9::text
         and s.resource_project=$10::text::jsonb and s.machine_size->'capacity'=$11::text::jsonb
         order by s.created_at desc,s.id desc limit 10`,
        [
          ...scope,
          selected.owner_id,
          selected.org_id,
          selected.golden_id,
          selected.provider,
          selected.harness,
          selected.model,
          selected.reasoning_effort,
          JSON.stringify(selected.resource_project),
          JSON.stringify(selected.machine_size.capacity),
        ],
      );
      const latest = await sql.query<{ observed_at: string | Date; observation: ProviderResourceObservation }>(
        `select o.observed_at,o.observation from public.resource_observations o join public.sandboxes s on s.id=o.sandbox_id
         where ${VISIBLE} and s.id=$3::uuid and o.observed_at >= $4::timestamptz-interval '7 days' and o.observed_at <= $4::timestamptz order by o.id desc limit 1`,
        [...scope, id, at],
      );
      const latestRow = latest.rows[0];
      const targetObservation = latestRow
        ? { at: new Date(latestRow.observed_at).toISOString(), observation: latestRow.observation }
        : null;
      const sessions: ResourceHistory["sessions"] = [];
      for (const row of result.rows) {
        const readings = await sql.query<{ observed_at: string | Date; observation: ProviderResourceObservation }>(
          `select o.observed_at,o.observation from public.resource_observations o join public.sandboxes s on s.id=o.sandbox_id
           where ${VISIBLE} and s.id=$3::uuid and o.observed_at >= $4::timestamptz-interval '14 days' and o.observed_at <= $4::timestamptz
           order by o.id desc limit 720`,
          [...scope, row.id, at],
        );
        sessions.push({
          sandbox: mapSandboxRow(row),
          observations: readings.rows.reverse().map((reading) => ({
            at: new Date(reading.observed_at).toISOString(),
            activity: "unknown",
            observation: reading.observation,
          })),
        });
      }
      return { target: selectedRecord, targetObservation, sessions };
    },
  };
}

/** Server maintenance only: permanently delete expired evidence even for inactive sandboxes.
 * The table is service-role-only; this operation never returns observations or user data.
 */
export async function pruneResourceObservations(sql: Sql, now: Date): Promise<void> {
  await sql.query("delete from public.resource_observations where observed_at < $1::timestamptz-interval '14 days'", [
    validNow(now),
  ]);
}
