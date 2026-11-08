import { createServerClient } from "@supabase/ssr";
import type { SupabaseClient } from "@supabase/supabase-js";
import { cookies } from "next/headers";
import { supabaseEnv } from "../env.ts";
import type { Database } from "./types.ts";

export type Supabase = SupabaseClient<Database>;

/** A client that acts as the signed-in user: their JWT from the session cookie, so row level security applies. */
export async function createClient(): Promise<Supabase> {
  const store = await cookies();
  const { url, anonKey } = supabaseEnv();
  return createServerClient<Database>(url, anonKey, {
    cookies: {
      getAll: () => store.getAll(),
      setAll(list) {
        try {
          for (const { name, value, options } of list) store.set(name, value, options);
        } catch {
          // Server Components cannot set cookies; the proxy refreshes the session instead.
        }
      },
    },
  });
}
