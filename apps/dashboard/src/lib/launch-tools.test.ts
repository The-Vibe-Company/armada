import { expect, test } from "bun:test";
import type { McpConnection } from "./connections";
import { launchToolGroups, rememberLaunchToolSelection } from "./launch-tools";

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
      new Map([
        ["blocked", true],
        ["selected", true],
      ]),
    ).map(({ title, tools }) => [title, tools.map(({ id }) => id)]),
  ).toEqual([
    ["Needs attention", ["blocked"]],
    ["On for this launch", ["selected"]],
    ["Available", ["available"]],
  ]);
});

test("tools discovered while the menu is open join it and keep their initial group after a toggle", () => {
  const empty = rememberLaunchToolSelection(new Map(), [], []);
  const loaded = rememberLaunchToolSelection(empty, [tool], [tool.id]);
  const afterToggle = rememberLaunchToolSelection(loaded, [tool], []);
  const [, onForThisLaunch] = launchToolGroups([tool], afterToggle);
  expect(onForThisLaunch.tools.map(({ id }) => id)).toEqual([tool.id]);
});
