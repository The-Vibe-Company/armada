import { VERSION } from "@armada/core";

/** What the server announces to MCP clients in its `initialize` answer. */
export const serverInfo = {
  name: "armada",
  version: VERSION,
} as const;
