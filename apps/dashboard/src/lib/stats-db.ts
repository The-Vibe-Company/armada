// Privileged access is isolated to /api/stats, never the signed-in Supabase client.
import postgres from "postgres";
import type { Queryable } from "./stats";

let client: ReturnType<typeof postgres> | undefined;

export async function statsAccounts(): Promise<{ client: Queryable } | null> {
  const url = process.env.ARMADA_DATABASE_URL;
  if (!url) return null;
  client ??= postgres(url, {
    max: 1,
    prepare: false,
    idle_timeout: 20,
    connect_timeout: 10,
  });
  const sql = client;
  return {
    client: {
      query: async (query, params) => ({ rows: await sql.unsafe(query, params) }),
    },
  };
}
