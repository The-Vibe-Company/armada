import type { Golden } from "@armada/core";
import type { Supabase } from "@/lib/supabase/server";

export async function listGoldens(supabase: Supabase): Promise<Golden[]> {
  const { data, error } = await supabase.from("goldens").select("*").order("name");
  if (error) throw new Error(error.message);
  return data;
}
