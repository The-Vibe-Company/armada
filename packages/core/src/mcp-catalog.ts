/** Browser-safe service identities. Availability is decided by the server. */
export const MCP_CATALOG = [
  {
    id: "notion",
    label: "Notion",
    url: "https://mcp.notion.com/mcp",
    docsUrl: "https://developers.notion.com/guides/mcp/overview",
  },
  { id: "linear", label: "Linear", url: "https://mcp.linear.app/mcp", docsUrl: "https://linear.app/docs/mcp" },
  {
    id: "slack",
    label: "Slack",
    url: "https://mcp.slack.com/mcp",
    docsUrl: "https://docs.slack.dev/ai/slack-mcp-server/",
  },
] as const;
export type McpCatalogId = (typeof MCP_CATALOG)[number]["id"];
