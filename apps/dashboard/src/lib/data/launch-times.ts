import type { LaunchPercentiles } from "@armada/core";
import type { Supabase } from "@/lib/supabase/server";

export type ProviderLaunchTimes = LaunchPercentiles[];

/** Complete activations accepted in the last 30 days, scoped to sandboxes visible to the viewer. */
export async function readLaunchTimes(supabase: Supabase, orgId: string): Promise<ProviderLaunchTimes | null> {
  const { data, error } = await supabase.rpc("sandbox_launch_percentiles", { target_org: orgId });
  if (error) {
    console.error("Launch times unavailable.");
    return null;
  }
  return data ?? [];
}
