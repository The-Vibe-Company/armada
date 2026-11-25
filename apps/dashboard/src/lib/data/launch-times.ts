import type { Supabase } from "@/lib/supabase/server";
import type { Database } from "@/lib/supabase/types";

export type ProviderLaunchTimes = Database["public"]["Functions"]["sandbox_launch_percentiles"]["Returns"];

/** Complete activations accepted in the last 30 days, scoped to sandboxes visible to the viewer. */
export async function readLaunchTimes(supabase: Supabase, orgId: string): Promise<ProviderLaunchTimes | null> {
  const { data, error } = await supabase.rpc("sandbox_launch_percentiles", { target_org: orgId });
  if (error) {
    console.error("Launch times unavailable.");
    return null;
  }
  return data ?? [];
}
