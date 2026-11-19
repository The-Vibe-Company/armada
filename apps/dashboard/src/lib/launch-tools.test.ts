import { expect, test } from "bun:test";
import type { McpConnection } from "./connections";
import { launchToolGroups } from "./launch-tools";

const tool: McpConnection = {
  id: "selected",
  name: "Selected tool",
  orgId: "org",
  scope: "personal",
  transport: "http",
  authType: "none",
  status: "connected",
  defaultForLaunch: true,
};

test("the Tools menu separates blocked, selected and available connections on open", () => {
  expect(
    launchToolGroups(
      [
        tool,
        { ...tool, id: "blocked", status: "needs_reconnect" },
        { ...tool, id: "available", defaultForLaunch: false },
      ],
      ["blocked", "selected"],
    ),
  ).toEqual([
    { title: "Needs attention", ids: ["blocked"] },
    { title: "On for this launch", ids: ["selected"] },
    { title: "Available", ids: ["available"] },
  ]);
});
