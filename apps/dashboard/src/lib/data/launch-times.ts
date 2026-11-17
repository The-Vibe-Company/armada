import { launchReadyPercentiles } from "@armada/core";
import type { Supabase } from "@/lib/supabase/server";

/** Bounded sample: the latest stage rows of the last 30 days. */
const WINDOW_DAYS = 30;
const MAX_ROWS = 2000;

export type ProviderLaunchTimes = ReturnType<typeof launchReadyPercentiles>;

/**
 * #2560: p50/p90 launch-to-ready time per provider for the organization. Row level security limits the sample to
 * sandboxes the viewer may open (all of them for an admin). Diagnostic: a failed read returns null and hides the section.
 */
export async function readLaunchTimes(supabase: Supabase, orgId: string): Promise<ProviderLaunchTimes | null> {
  const since = new Date(Date.now() - WINDOW_DAYS * 86_400_000).toISOString();
  const { data, error } = await supabase
    .from("sandbox_launch_stages")
    .select("sandbox_id,epoch,stage,at,sandboxes!inner(provider,org_id)")
    .in("stage", ["created", "harness_ready"])
    .eq("sandboxes.org_id", orgId)
    .gte("at", since)
    .order("at", { ascending: false })
    .limit(MAX_ROWS);
  if (error) {
    console.error("Launch times unavailable.");
    return null;
  }
  return launchReadyPercentiles(
    (data ?? []).map((row) => ({
      sandbox_id: row.sandbox_id,
      epoch: row.epoch,
      stage: row.stage,
      at: row.at,
      provider: row.sandboxes.provider,
    })),
  );
}
