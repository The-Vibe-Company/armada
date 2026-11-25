import type { Harness } from "../src/contract.ts";
import type { SandboxStatus } from "../src/database.types.ts";
import type { Sql } from "../src/golden-store.ts";
import type { MachineSizeEvidence } from "../src/machine-size.ts";
import { mapSandboxRow, type ResourceProject, type SandboxRow } from "../src/sandbox.ts";
import type { SandboxProviderId } from "../src/sandbox-provider.ts";

const COLUMNS = `runtime_transport,boat_runtime,skills, preservation_note, task_outcome, task_prompt_id, credential_id, credential_version, id, provider::text as provider, provider_sandbox_id, golden_id, org_id, owner_id, harness::text as harness, status::text as status,
  conversation_ids, created_at, stopped_at, deleted_at, status_reason, model, reasoning_effort, machine_size, resource_project, visibility, repository_dir, expires_at, effective_ttl_seconds, requested_ttl_seconds, last_observed_at, lifecycle_error, lifecycle_generation, stop_requested_at, external_ref`;

export interface SandboxFixtureInput {
  boatRuntime?: true;
  modalTransport?: "dialout";
  credentialId?: string;
  credentialVersion?: number;
  id: string;
  provider: SandboxProviderId;
  providerSandboxId: string;
  goldenId: string;
  orgId: string;
  ownerId: string;
  harness: Harness;
  status: SandboxStatus;
  machineSize?: MachineSizeEvidence;
  resourceProject?: ResourceProject;
  activityLeaseId?: string;
  expiresAt?: string;
  requestedTtlSeconds?: number;
  effectiveTtlSeconds?: number;
  repositoryDir?: string | null;
  model: string;
  reasoningEffort: string;
  visibility?: "private" | "org";
  externalRef?: string;
  stopWhenWorkMerged?: boolean;
  pullRequestSource?: { connectionEpoch: string; repositories: { url: string; dir: string; branch?: string }[] };
}

export async function insertSandboxFixture(sql: Sql, input: SandboxFixtureInput) {
  const result = await sql.query<SandboxRow>(
    `insert into public.sandboxes (id, provider_sandbox_id, golden_id, org_id, owner_id, harness, status, model,
       reasoning_effort, provider, visibility, repository_dir, requested_ttl_seconds, effective_ttl_seconds, expires_at, activity_lease_id, activity_until, credential_id, credential_version, machine_size, resource_project, boat_runtime, runtime_transport, external_ref, stop_when_work_merged, pull_request_source)
     values ($1, $2, $3, $4, $5, $6::public.harness, $7::public.sandbox_status, $8, $9, $10::public.sandbox_provider, $11::public.visibility, $12::text, $13::integer, $14::integer, coalesce($20::timestamptz, now() + $14::integer * interval '1 second'), $15::uuid, case when $15::uuid is not null then now()+interval '2 minutes' else null end, $16::uuid, $17::integer, $18::text::jsonb, $19::text::jsonb, $21::boolean,$22::text,$23::text,$24::boolean,$25::text::jsonb)
     returning ${COLUMNS}`,
    [
      input.id,
      input.providerSandboxId,
      input.goldenId,
      input.orgId,
      input.ownerId,
      input.harness,
      input.status,
      input.model,
      input.reasoningEffort,
      input.provider,
      input.visibility ?? null,
      input.repositoryDir ?? null,
      input.requestedTtlSeconds ?? null,
      input.effectiveTtlSeconds ?? 14400,
      input.activityLeaseId ?? null,
      input.credentialId ?? null,
      input.credentialVersion ?? null,
      JSON.stringify(input.machineSize ?? null),
      JSON.stringify(input.resourceProject ?? null),
      input.expiresAt ?? null,
      input.boatRuntime === true,
      input.modalTransport ?? null,
      input.externalRef ?? null,
      input.stopWhenWorkMerged ?? true,
      JSON.stringify(input.pullRequestSource ?? null),
    ],
  );
  const row = result.rows[0];
  if (!row) throw new Error("The sandbox could not be recorded.");
  return mapSandboxRow(row);
}
