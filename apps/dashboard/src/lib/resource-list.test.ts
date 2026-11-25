import { describe, expect, test } from "bun:test";
import { capacityParts, environmentState } from "./environments.ts";
import { goldenLaunchReadiness } from "./golden-form.ts";
import { matchesQuery, sortResources } from "./resource-list.ts";
import { serviceOffer, toolFact, toolState } from "./tools.ts";

describe("the Build lists", () => {
  test("sort what needs action first, then what is ready, then the rest, by name inside each", () => {
    const rows = [
      { name: "zeta", bucket: "ready" as const },
      { name: "alpha", bucket: "rest" as const },
      { name: "Beta", bucket: "action" as const },
      { name: "api-2", bucket: "ready" as const },
      { name: "api-10", bucket: "ready" as const },
      { name: "alpha", bucket: "action" as const },
    ];
    expect(sortResources(rows).map((row) => `${row.bucket}:${row.name}`)).toEqual([
      "action:alpha",
      "action:Beta",
      "ready:api-2",
      "ready:api-10",
      "ready:zeta",
      "rest:alpha",
    ]);
  });

  test("twins of one name keep a stable order by their tie-breaker", () => {
    const rows = [
      { name: "web", bucket: "ready" as const, tie: "modal" },
      { name: "web", bucket: "ready" as const, tie: "boat" },
    ];
    expect(sortResources(rows).map((row) => row.tie)).toEqual(["boat", "modal"]);
  });

  test("the filter keeps an item holding every word of the query, in any case and order", () => {
    expect(matchesQuery("shared-snapshot Boat acme/web acme/api", "API boat")).toBe(true);
    expect(matchesQuery("shared-snapshot Boat acme/web", "modal")).toBe(false);
    expect(matchesQuery("anything", "   ")).toBe(true);
  });
});

const ready = goldenLaunchReadiness({ provider: "boat", hasSnapshot: true, serverReady: true, connected: ["boat"] });
const unsnapshotted = goldenLaunchReadiness({
  provider: "boat",
  hasSnapshot: false,
  serverReady: true,
  connected: ["boat"],
});

describe("an environment's row", () => {
  test("a snapshotted environment on a connected provider is ready and launches from its row", () => {
    expect(
      environmentState({ provider: "boat", readiness: ready, providerMissing: false, buildBlocker: null }),
    ).toMatchObject({
      bucket: "ready",
      label: "Ready",
      action: "launch",
    });
  });

  test("without a snapshot, the viewer who can build it is asked to; anyone else sees it waits on someone", () => {
    const own = environmentState({
      provider: "boat",
      readiness: unsnapshotted,
      providerMissing: false,
      buildBlocker: null,
    });
    expect(own).toMatchObject({ bucket: "action", label: "Not built yet", action: "snapshot" });
    const other = environmentState({
      provider: "boat",
      readiness: unsnapshotted,
      providerMissing: false,
      buildBlocker: "Only an org admin rebuilds an org snapshot.",
    });
    expect(other).toMatchObject({
      bucket: "rest",
      action: null,
      detail: "Only an org admin rebuilds an org snapshot.",
    });
  });

  test("a provider the org has not connected is the fix, before the snapshot it cannot build yet", () => {
    const missing = goldenLaunchReadiness({
      provider: "modal",
      hasSnapshot: false,
      serverReady: true,
      connected: ["boat"],
    });
    expect(
      environmentState({ provider: "modal", readiness: missing, providerMissing: true, buildBlocker: "x" }),
    ).toMatchObject({
      bucket: "action",
      label: "Modal not connected",
      detail: "An org admin connects Modal in Machines → Cloud providers to build and launch it.",
      action: "connect",
    });
  });

  test("a server that is not configured or a provider status that cannot be read offers no row action", () => {
    const paused = goldenLaunchReadiness({ provider: "boat", hasSnapshot: true, serverReady: true, connected: null });
    expect(
      environmentState({ provider: "boat", readiness: paused, providerMissing: false, buildBlocker: null }),
    ).toMatchObject({
      bucket: "rest",
      label: "Launch paused",
      action: null,
    });
  });
});

describe("the capacity line", () => {
  test("says each provider's slots in one phrase, the slot a removed environment holds, and an unbounded one", () => {
    expect(
      capacityParts([
        { provider: "boat", state: { kind: "full", capacity: 1, used: 1 }, removed: 1 },
        { provider: "modal", state: { kind: "unknown" }, removed: 0 },
      ]).map((part) => part.text),
    ).toEqual([
      "Boat allows 1 snapshot here; 1 is using that capacity. 1 place is still held by removed snapshots. There is no room for another snapshot.",
      "Modal has no snapshot limit.",
    ]);
    expect(
      capacityParts([{ provider: "boat", state: { kind: "unavailable", reason: "No key." }, removed: 0 }]),
    ).toEqual([
      {
        provider: "boat",
        kind: "unavailable",
        text: "Boat snapshot capacity could not be checked.",
        reason: "No key.",
      },
    ]);
  });
});

describe("a tool's row", () => {
  const remote = { transport: "http" as const, authType: "oauth" as const };

  test("a connected tool is ready; a lapsed or unreachable one asks its manager to reconnect or retry", () => {
    expect(toolState({ ...remote, status: "connected" }, true)).toMatchObject({ bucket: "ready", action: null });
    expect(toolState({ ...remote, status: "needs_reconnect" }, true)).toMatchObject({
      bucket: "action",
      tone: "warning",
      action: "Reconnect",
    });
    expect(toolState({ ...remote, status: "unavailable" }, true)).toMatchObject({ bucket: "action", action: "Retry" });
    expect(toolState({ transport: "stdio", authType: "none", status: "not_connected" }, true)).toMatchObject({
      label: "Not configured",
      action: "Configure",
    });
  });

  test("a member who cannot manage an org tool gets no action, and it sorts with the rest; disabled too", () => {
    expect(toolState({ ...remote, status: "needs_reconnect" }, false)).toMatchObject({ bucket: "rest", action: null });
    expect(toolState({ ...remote, status: "disabled" }, true)).toMatchObject({ bucket: "rest", label: "Disabled" });
  });

  test("a catalog service offers Connect, then Connect another per account; one that needs setup offers its setup", () => {
    const linear = { id: "linear", availability: "available" } as const;
    expect(serviceOffer(linear, [{}])).toEqual({ tone: "neutral", label: "Not added", count: 0, action: "connect" });
    expect(serviceOffer(linear, [{ catalogId: "linear" }, { catalogId: "linear" }, {}])).toEqual({
      tone: "success",
      label: "Added",
      count: 2,
      action: "another",
    });
    expect(serviceOffer({ id: "slack", availability: "setup_required" }, [{ catalogId: "slack" }])).toEqual({
      tone: "warning",
      label: "Needs server setup",
      count: 1,
      action: "setup",
    });
  });

  test("its useful fact is who it signed in as and how many tools it exposes", () => {
    expect(toolFact({ transport: "http", accountLabel: "alice@linear.test", toolCount: 21 })).toBe(
      "Signed in as alice@linear.test · 21 tools",
    );
    expect(toolFact({ transport: "stdio", toolCount: 3 })).toBeNull();
    expect(toolFact({ transport: "http", toolCount: 1 })).toBe("1 tool");
  });
});
