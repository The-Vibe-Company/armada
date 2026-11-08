export type SupabaseEnv = { url: string; anonKey: string };

/** The only Supabase settings the dashboard has: a URL and the public anon key. Never a service key. */
export function supabaseEnv(): SupabaseEnv {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) {
    throw new Error("Set NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY.");
  }
  return { url, anonKey };
}

export function isConfigured(): boolean {
  return Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY);
}

export function mcpUrl(): string | null {
  return process.env.ARMADA_MCP_URL?.trim() || null;
}

export function masterKey(): string | undefined {
  return process.env.ARMADA_MASTER_KEY;
}
