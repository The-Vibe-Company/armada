import type { ClientConfig } from "@armada/core";
import { enabledProviders } from "../../../lib/auth-config";
import { mcpUrl, supabaseEnv } from "../../../lib/env";

export const dynamic = "force-dynamic";

/** Anonymous discovery for the CLI: an explicit allowlist of public settings only. */
export function GET(): Response {
  const { url, anonKey } = supabaseEnv();
  const mcp = mcpUrl();
  if (!mcp) return Response.json({ error: "Armada server is not configured." }, { status: 503 });
  const config: ClientConfig = {
    version: 1,
    supabaseUrl: url,
    anonKey,
    controlUrl: new URL(mcp).origin,
    providers: enabledProviders(process.env.NEXT_PUBLIC_AUTH_PROVIDERS),
  };
  return Response.json(config, { headers: { "cache-control": "no-store" } });
}
