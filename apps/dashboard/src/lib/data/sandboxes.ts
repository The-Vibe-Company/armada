import {
  type CredentialKind,
  type Harness,
  isHarness,
  LAUNCH_STAGES,
  type LaunchTiming,
  type Sandbox,
  type SandboxCost,
  summarizeLaunch,
} from "@armada/core";
import { isUuid } from "@/lib/action";
import type { BillingAccountMetadata } from "@/lib/billing-account";
import { boundedEnrichment } from "@/lib/bounded-enrichment";
import { parseSandboxListMetadata, type SandboxListMetadata, type SkippedSandboxRow } from "@/lib/sandbox-access";
import { costOfRow } from "@/lib/sandbox-cost";
import type { Supabase } from "@/lib/supabase/server";
import { selectedOrganization } from "./selected-org";

// Explicit JWT projection: schema additions must be reviewed before becoming dashboard data.
const SANDBOXES_COLUMNS =
  "id,golden_id,org_id,owner_id,harness,status,conversation_ids,created_at,stopped_at,deleted_at,status_reason,model,reasoning_effort,provider,provider_sandbox_id,visibility,source_golden_visibility,access_owner_id,mcp_generation,repository_dir,requested_ttl_seconds,effective_ttl_seconds,expires_at,lifecycle_generation,last_observed_at,lifecycle_error,reconcile_after,stop_requested_at,activity_lease_id,activity_until,reconcile_lease,reconcile_lease_until,credential_id,credential_version,machine_size,resource_project,resource_sampling_claim_id,resource_sampling_after,resource_sampling_generation,orchestrator_native_generation,task_outcome,pull_requests,task_prompt_id,preservation_note,usage_runtime_seconds,usage_running_since,usage_turns,skills,stop_generation,preservation_stop_generation,application_secret_tainted,boat_runtime,docker_host_id,docker_installation_id,docker_generation,docker_image,runtime_transport,docker_snapshot_id";

/** The listed metadata of one sandbox of the selected organization, or null when the server lists no such sandbox. */
export async function getSandboxMetadata(supabase: Supabase, id: string): Promise<SandboxListMetadata | null> {
  const selected = await selectedOrganization();
  if (!selected) return null;
  const { data, error } = await supabase
    .rpc("sandbox_list_metadata")
    .eq("id", id)
    .eq("orgId", selected.org.id)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) return null;
  const parsed = parseSandboxListMetadata([data]);
  logSkipped(parsed.skipped);
  return parsed.rows[0] ?? null;
}

/** Server-side only: the row id and the failed contract check, never a row value. */
function logSkipped(skipped: readonly SkippedSandboxRow[]) {
  for (const row of skipped)
    console.error(`Sandbox list row left out: ${row.reason} does not match the contract (id ${row.id ?? "unknown"}).`);
}

export type SandboxDetail = Omit<
  Sandbox,
  | "boat_id"
  | "harness"
  | "docker_retention_deadline"
  | "external_ref"
  | "outputs_attempt_count"
  | "outputs_checked_at"
  | "outputs_published_scan"
  | "outputs_retained_generation"
  | "outputs_failure_reasons"
  | "outputs_probe_at"
  | "outputs_collector_supported"
  | "pull_request_source"
  | "pull_request_scan"
  | "pull_request_reports"
  | "pull_request_check_after"
  | "pull_request_merge_proof"
  | "stop_when_work_merged"
  | "transition_context"
> & { harness: Harness; publicStatus: Sandbox["status"] };

/** The interior row. Row level security returns it only to its owner or a current organization admin. */
export async function getSandbox(supabase: Supabase, id: string): Promise<SandboxDetail | null> {
  const selected = await selectedOrganization();
  if (!selected) return null;
  const orgId = selected.org.id;
  const [{ data, error }, readiness] = await Promise.all([
    supabase.from("sandboxes").select(SANDBOXES_COLUMNS).eq("id", id).eq("org_id", orgId).maybeSingle(),
    supabase.rpc("sandbox_detail_status", { target_id: id, target_org: orgId }),
  ]);
  if (error) throw new Error(error.message);
  if (readiness.error) throw new Error(readiness.error.message);
  if (!data || !isHarness(data.harness) || readiness.data === null) return null;
  return { ...data, harness: data.harness, publicStatus: readiness.data };
}

/**
 * The kind of each readable account among `ids`, by id. Row level security returns an org account to its members and a
 * personal one to its owner: an account the viewer cannot read is absent, and its sandbox's cost is "API-equivalent".
 */
async function credentialKinds(supabase: Supabase, ids: readonly (string | null)[]) {
  const wanted = [...new Set(ids.filter((id): id is string => typeof id === "string"))];
  const kinds = new Map<string, CredentialKind>();
  if (wanted.length === 0) return kinds;
  const data = await boundedEnrichment("credentialKinds", wanted, (ids) =>
    supabase.from("credentials").select("id,kind").in("id", ids),
  );
  for (const row of data ?? []) kinds.set(row.id, row.kind);
  return kinds;
}

/** Only user-JWT-readable billing metadata; absent/private accounts and failed reads remain unavailable. */
export async function credentialMetadata(
  supabase: Supabase,
  ids: readonly (string | null)[],
): Promise<Map<string, BillingAccountMetadata>> {
  const wanted = [...new Set(ids.filter((id): id is string => typeof id === "string"))];
  const accounts = new Map<string, BillingAccountMetadata>();
  if (wanted.length === 0) return accounts;
  const data = await boundedEnrichment("credentialMetadata", wanted, (ids) =>
    supabase.from("credentials").select("id,name,kind").in("id", ids),
  );
  for (const row of data ?? []) accounts.set(row.id, { id: row.id, name: row.name, kind: row.kind });
  return accounts;
}

/** Interior facts for the current page. RLS still checks each requested row against the user's JWT. */
export async function listSandboxEnrichment(
  supabase: Supabase,
  orgId: string,
  rows: readonly Pick<SandboxListMetadata, "id" | "canOpen">[],
) {
  const readableIds = rows.filter(({ id, canOpen }) => canOpen && isUuid(id)).map(({ id }) => id);
  const data = await boundedEnrichment("listSandboxEnrichment", readableIds, (ids) =>
    supabase
      .from("sandboxes")
      .select(
        "id,harness,credential_id,usage_turns,usage_runtime_seconds,usage_running_since,docker_host_id,goldens!sandboxes_golden_id_fkey(name)",
      )
      .eq("org_id", orgId)
      .eq("goldens.org_id", orgId)
      .in("id", ids),
  );
  const kinds = await credentialKinds(
    supabase,
    data.map((row) => row.credential_id),
  );
  const enrichment = new Map<string, { cost?: SandboxCost; hostId: string | null; snapshot?: string }>();
  for (const { goldens, docker_host_id, ...row } of data) {
    const cost = isHarness(row.harness)
      ? costOfRow({ ...row, harness: row.harness }, kinds.get(row.credential_id ?? "") ?? null)
      : undefined;
    enrichment.set(row.id, {
      ...(cost && { cost }),
      hostId: docker_host_id,
      ...(goldens?.name && { snapshot: goldens.name }),
    });
  }
  return enrichment;
}

/**
 * #2560: the latest launch or resume's recorded stages. Row level security returns them only with a sandbox the viewer
 * may open. Timing is diagnostic: a failed read hides the fact instead of failing the page.
 */
export async function getLaunchTiming(supabase: Supabase, id: string): Promise<LaunchTiming | null> {
  // Newest activation first, at most one activation's worth of rows: summarizeLaunch keeps only the latest one.
  const { data, error } = await supabase
    .from("sandbox_launch_stages")
    .select("activation,stage,at")
    .eq("sandbox_id", id)
    .order("activation", { ascending: false })
    .limit(LAUNCH_STAGES.length);
  if (error) {
    console.error(`Launch timing unavailable for sandbox ${id}.`);
    return null;
  }
  return summarizeLaunch(data ?? []);
}
