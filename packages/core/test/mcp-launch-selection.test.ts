import { expect, test } from "bun:test";
import { mcpLaunchSelection } from "../src/mcp-launch-selection.ts";

test("launch preview preserves disconnected defaults and deliberate overrides", () => {
  const available = [
    { id: "ready", status: "connected", defaultForLaunch: true },
    { id: "reconnect", status: "needs_reconnect", defaultForLaunch: true },
    { id: "disabled", status: "disabled", defaultForLaunch: true },
    { id: "other", status: "connected", defaultForLaunch: false },
  ] as const;
  expect(mcpLaunchSelection(available)).toEqual({ ids: ["ready", "reconnect"], blockedIds: ["reconnect"] });
  expect(mcpLaunchSelection(available, [])).toEqual({ ids: [], blockedIds: [] });
  expect(mcpLaunchSelection(available, ["other", "other"])).toEqual({ ids: ["other"], blockedIds: [] });
  expect(mcpLaunchSelection(available, ["disabled", "missing"])).toEqual({
    ids: ["disabled", "missing"],
    blockedIds: ["disabled", "missing"],
  });
});
