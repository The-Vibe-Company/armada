import type { CredentialKind, Sandbox, SandboxCost, SandboxListMetadata } from "@armada/core";
import { isUuid } from "@/lib/action";
import type { BillingAccountMetadata } from "@/lib/billing-account";
import { boundedEnrichment } from "@/lib/bounded-enrichment";
import type { DockerHostList } from "@/lib/docker-hosts";
import { parseSandboxListMetadata, type SkippedSandboxRow } from "@/lib/sandbox-access";
import { costOfRow } from "@/lib/sandbox-cost";
import type { Supabase } from "@/lib/supabase/server";
import { selectedOrganization } from "./selected-org";

// Explicit JWT projection: schema additions must be reviewed before becoming dashboard data.
const SANDBOXES_COLUMNS =
  "id,boat_id,golden_id,org_id,owner_id,harness,status,conversation_ids,created_at,stopped_at,deleted_at,status_reason,model,reasoning_effort,provider,provider_sandbox_id,visibility,source_golden_visibility,access_owner_id,mcp_generation,repository_dir,requested_ttl_seconds,effective_ttl_seconds,expires_at,lifecycle_generation,last_observed_at,lifecycle_error,reconcile_after,stop_requested_at,activity_lease_id,activity_until,reconcile_lease,reconcile_lease_until,credential_id,credential_version,machine_size,resource_project,resource_sampling_claim_id,resource_sampling_after,resource_sampling_generation,orchestrator_native_generation,task_outcome,task_prompt_id,preservation_note,usage_runtime_seconds,usage_running_since,usage_turns,skills,stop_generation,preservation_stop_generation,application_secret_tainted,boat_runtime,docker_host_id,docker_installation_id,docker_generation,docker_image,runtime_transport,docker_snapshot_id,docker_retention_deadline";

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

/** The interior row. Row level security returns it only to its owner or a current organization admin. */
export async function getSandbox(supabase: Supabase, id: string): Promise<Sandbox | null> {
  const selected = await selectedOrganization();
  if (!selected) return null;
  const { data, error } = await supabase
    .from("sandboxes")
    .select(SANDBOXES_COLUMNS)
    .eq("id", id)
    .eq("org_id", selected.org.id)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data;
}

/**
 * The kind of each readable account among `ids`, by id. Row level security returns an org account to its members and a
 * personal one to its owner: an account the viewer cannot read is absent, and its sandbox's cost is "API-equivalent".
 */
export async function credentialKinds(supabase: Supabase, ids: readonly (string | null)[]) {
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

/**
 * The cost of the listed sandboxes the viewer may open, by id. The usage columns are interior: row level security
 * returns them to the owner and the org's admins only, as the server's list does, so another member's row has none.
 */
export function listSandboxCosts(
  supabase: Supabase,
  rows: readonly Pick<SandboxListMetadata, "id" | "canOpen">[],
): Promise<Map<string, SandboxCost>> {
  return sandboxCosts(
    supabase,
    rows.filter((row) => row.canOpen).map((row) => row.id),
  );
}

/** The cost of each sandbox among `ids` whose row row level security returns to the viewer (owner or org admin), by id. */
export async function sandboxCosts(supabase: Supabase, ids: readonly string[]): Promise<Map<string, SandboxCost>> {
  const costs = new Map<string, SandboxCost>();
  // A malformed sandbox id is never queried.
  const wanted = [...new Set(ids)].filter(isUuid);
  if (wanted.length === 0) return costs;
  const data = await boundedEnrichment("sandboxCosts", wanted, (ids) =>
    supabase
      .from("sandboxes")
      .select("id,harness,credential_id,usage_turns,usage_runtime_seconds,usage_running_since")
      .in("id", ids),
  );
  const kinds = await credentialKinds(
    supabase,
    (data ?? []).map((row) => row.credential_id),
  );
  for (const row of data ?? []) costs.set(row.id, costOfRow(row, kinds.get(row.credential_id ?? "") ?? null));
  return costs;
}

/** Host bindings are interior: enrich only readable Docker rows, never the organization metadata contract. */
export async function listSandboxHostNames(
  supabase: Supabase,
  rows: readonly SandboxListMetadata[],
  hosts: DockerHostList | null,
): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  const wanted = rows.filter((row) => row.provider === "docker" && row.canOpen && isUuid(row.id)).map((row) => row.id);
  if (wanted.length === 0 || hosts === null) return names;
  const selected = await selectedOrganization();
  if (!selected) return names;
  const data = await boundedEnrichment("listSandboxHostNames", wanted, (ids) =>
    supabase
      .from("sandboxes")
      .select("id,docker_host_id")
      .eq("org_id", selected.org.id)
      .eq("provider", "docker")
      .in("id", ids),
  );
  const byId = new Map(hosts.hosts.map((host) => [host.id, host]));
  for (const row of data ?? []) {
    const host = row.docker_host_id ? byId.get(row.docker_host_id) : undefined;
    names.set(
      row.id,
      row.docker_host_id === null
        ? "Machine not recorded"
        : host
          ? (host.name ?? "Unnamed machine")
          : "Machine name unavailable",
    );
  }
  return names;
}
