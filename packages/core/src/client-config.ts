/** Public discovery document. Never include service keys or encrypted credential values. */
export const CLIENT_CONFIG_PATH = "/.well-known/armada.json";

export interface ClientConfig {
  version: 1;
  supabaseUrl: string;
  anonKey: string;
  /** The control API origin; the dashboard and MCP server may live on different hosts. */
  controlUrl: string;
  providers: ("github" | "google")[];
}
