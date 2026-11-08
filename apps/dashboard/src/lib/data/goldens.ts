import type { Golden } from "@armada/core";
import type { Supabase } from "@/lib/supabase/server";
import { selectedOrganization } from "./selected-org";

export async function listGoldens(supabase: Supabase): Promise<Golden[]> {
  const selected = await selectedOrganization();
  if (!selected) return [];
  const { data, error } = await supabase.from("goldens").select("*").eq("org_id", selected.org.id).order("name");
  if (error) throw new Error(error.message);
  return data;
}
