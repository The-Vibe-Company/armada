import { describe, expect, test } from "bun:test";
import { boatFull, capacityParts, environmentBlockers, environmentState } from "../src/lib/environments.ts";
import { goldenLaunchReadiness } from "../src/lib/golden-form.ts";
import { matchesQuery, sortResources } from "../src/lib/resource-list.ts";
import { serviceOffer, toolBlockers, toolFact, toolState } from "../src/lib/tools.ts";

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
    expect(matchesQuery("shared-golden Boat acme/web acme/api", "API boat")).toBe(true);
    expect(matchesQuery("shared-golden Boat acme/web", "modal")).toBe(false);
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
    expect(own).toMatchObject({ bucket: "action", label: "Needs a snapshot", action: "snapshot" });
    const other = environmentState({
      provider: "boat",
      readiness: unsnapshotted,
      providerMissing: false,
      buildBlocker: "Only an org admin rebuilds an org golden.",
    });
    expect(other).toMatchObject({ bucket: "rest", action: null, detail: "Only an org admin rebuilds an org golden." });
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
    ).toMatchObject({ bucket: "action", label: "Modal not connected", action: "connect" });
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

describe("what blocks launching an environment", () => {
  const row = (key: string, name: string, provider: "boat" | "modal", action: "snapshot" | "connect" | "launch") => ({
    key,
    name,
    provider,
    state: { bucket: "action" as const, tone: "warning" as const, label: "", detail: "", action },
  });

  test("each missing provider once, with how many environments wait, then each environment to snapshot", () => {
    const blockers = environmentBlockers({
      providerPending: false,
      rows: [
        row("1", "docs", "modal", "connect"),
        row("2", "api", "modal", "connect"),
        row("3", "alice-private", "boat", "snapshot"),
        row("4", "web", "boat", "launch"),
      ],
    });
    expect(blockers.map((blocker) => [blocker.label, blocker.detail, blocker.target])).toEqual([
      ["Connect Modal", "2 environments wait for it.", { href: "/settings" }],
      ["Snapshot alice-private", "Build it once before launching from it.", { item: "3" }],
    ]);
  });

  test("an org without any provider is told to connect one; twins to snapshot are told apart by provider", () => {
    const blockers = environmentBlockers({
      providerPending: true,
      rows: [row("1", "web", "boat", "snapshot"), row("2", "web", "modal", "snapshot")],
    });
    expect(blockers.map((blocker) => blocker.label)).toEqual([
      "Connect a sandbox provider",
      "Snapshot web on Boat",
      "Snapshot web on Modal",
    ]);
  });

  test("nothing blocks: the strip is empty", () => {
    expect(environmentBlockers({ providerPending: false, rows: [row("1", "web", "boat", "launch")] })).toEqual([]);
  });
});

describe("the capacity line", () => {
  test("says each provider's slots in one phrase, the slot a removed environment holds, and an unbounded one", () => {
    expect(
      capacityParts([
        { provider: "boat", state: { kind: "full", capacity: 1, used: 1 }, removed: 1 },
        { provider: "modal", state: { kind: "unknown" }, removed: 0 },
      ]).map((part) => part.text),
    ).toEqual(["Boat: 1 of 1 slot used, 1 by removed environment", "Modal: no limit"]);
    expect(
      capacityParts([{ provider: "boat", state: { kind: "unavailable", reason: "No key." }, removed: 0 }]),
    ).toEqual([{ provider: "boat", kind: "unavailable", text: "Boat: capacity unavailable", reason: "No key." }]);
  });

  test("Boat is full when every slot is used, or more than every slot by older environments", () => {
    expect(boatFull({ boat: { kind: "full", capacity: 1, used: 1 } })).toBe(true);
    expect(boatFull({ boat: { kind: "legacy", capacity: 1, used: 2 } })).toBe(true);
    expect(boatFull({ boat: { kind: "available", capacity: 2, used: 1 } })).toBe(false);
    expect(boatFull({ modal: { kind: "unknown" } })).toBe(false);
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

  test("the strip names each tool the viewer can fix by its fix, with the server's last error", () => {
    const state = toolState({ ...remote, status: "needs_reconnect" }, true);
    const blockers = toolBlockers([
      { key: "c1", connection: { name: "Acme Sentry", lastError: "Token revoked." }, state },
      { key: "c2", connection: { name: "Docs" }, state: toolState({ ...remote, status: "connected" }, true) },
    ]);
    expect(blockers).toEqual([
      { key: "fix-c1", label: "Reconnect Acme Sentry", detail: "Token revoked.", target: { item: "c1" } },
    ]);
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
