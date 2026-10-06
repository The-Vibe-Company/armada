import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildStatus, type DeferredLaunch, type Fleet, type MergeOutcome, parseConfig } from "@armada/core";
import { memoryFleet } from "../../core/test/memory-fleet.ts";
import { ARMADA_URL, DEMO_TOML, fakeArmada, issue, NOW } from "../../core/test/support.ts";
import { run } from "../src/cli.ts";
import { launchDeferredAfterMerge } from "../src/deferred-launch.ts";
import type { Io } from "../src/io.ts";
import { renderStatus } from "../src/render.ts";

const config = parseConfig(
  `${DEMO_TOML}\n[conductor.profiles.backend]\nagent = "codex"\nmodel = "synthetic-model"\neffort = "high"\n`,
);
const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

test("launch --when-unblocked and --after store server-checked requests, print blockers and show parked state in status", async () => {
  const home = await mkdtemp(join(tmpdir(), "armada-deferred-"));
  dirs.push(home);
  const program = {
    rootId: "DEMO-1",
    issues: [
      issue("DEMO-1", { parentId: null }),
      issue("DEMO-7", { parentId: "DEMO-1" }),
      issue("DEMO-9", { parentId: "DEMO-1", blockedBy: [{ id: "DEMO-7", statusType: "unstarted" }] }),
    ],
    comments: [],
    warnings: [],
    fetchedAt: NOW.toISOString(),
  };
  const facts = {
    config,
    snapshot: {
      repository: "acme/widgets",
      issues: program.issues,
      prs: [],
      parkedLabel: config.tracker.parkedLabel,
      flight: { program, forge: null, after: program.fetchedAt },
    },
  };
  const store = memoryFleet();
  const api = fakeArmada({
    keys: { armada_key_TEST: "test" },
    facts,
    store,
    vault: { linear: { apiKey: "lin_test", scope: "own" }, now: () => NOW },
  });
  const lines: string[] = [];
  const io: Io = {
    cwd: "/work",
    env: { XDG_CONFIG_HOME: home, ARMADA_API_URL: ARMADA_URL, ARMADA_API_KEY: "armada_key_TEST" },
    readFile: async () =>
      `${DEMO_TOML}\n[conductor.profiles.backend]\nagent = "codex"\nmodel = "synthetic-model"\neffort = "high"\n`,
    fetch: api.fetch,
    stdout: (t) => lines.push(t),
    stderr: (t) => lines.push(t),
    ghToken: () => null,
    now: () => NOW,
  };
  expect(await run(["launch", "demo-9", "--when-unblocked", "--profile", "backend", "--after", "demo-7"], io)).toBe(0);
  expect(lines.join("")).toContain("DEMO-9 will launch once DEMO-7 is done");
  expect(api.calls.some((c) => c.path === "launch-tokens")).toBe(false);
  expect(store.items).toMatchObject([{ ticket: "DEMO-9", requestDeferred: true }]);
  const item = store.items[0];
  if (!item) throw new Error("missing request");
  await api.store.resolveInboxItem({ project: "widgets", id: item.id, resolution: "declined", at: NOW });
  lines.length = 0;
  expect(await run(["launch", "demo-9", "--after", "demo-7", "--json"], io)).toBe(0);
  expect(JSON.parse(lines.join(""))).toMatchObject({ ticket: "DEMO-9", blockers: ["DEMO-7"], owned: true });
  program.issues[2]?.labels.push(config.tracker.parkedLabel);
  const deferred = await api.store.openInboxItems({ project: "widgets", recipient: "coordinator" });
  const { deferredLaunchState } = await import("../../core/src/deferred.ts");
  const { buildModel } = await import("../../core/src/model.ts");
  const report = buildStatus({
    config,
    program,
    forge: null,
    now: NOW,
    launchWhenUnblocked: deferred.map((i) =>
      deferredLaunchState(i, buildModel(program.issues, program.rootId), config.tracker.parkedLabel, false),
    ),
  });
  expect(renderStatus(report)).toContain("Launch when unblocked (1)\n  DEMO-9  parked");
  lines.length = 0;
  expect(await run(["launch", "demo-9", "--when-unblocked", "--notes", "notes.txt"], io)).toBe(2);
  expect(lines.join("")).toContain("--notes cannot be stored");
  for (const empty of [["--after="], ["--after", ""]]) {
    lines.length = 0;
    expect(await run(["launch", "demo-9", ...empty], io)).not.toBe(0);
    expect(lines.join("")).toContain("after must be a ticket id");
  }
  expect(api.calls.some((c) => c.path === "launch-tokens")).toBe(false);
});

test("post-merge launches only ready requests owned by this coordinator with stored facts, and preserves failed requests", async () => {
  const request = (ticket: string, extra: Partial<DeferredLaunch> = {}): DeferredLaunch => ({
    id: 1,
    ticket,
    author: "Ada",
    profile: "backend",
    blockers: ["DEMO-7"],
    reason: "waits on DEMO-7",
    owned: true,
    command: `armada launch ${ticket}`,
    ...extra,
  });
  const requests = [
    request("DEMO-9"),
    request("DEMO-10", { owned: false }),
    request("DEMO-11", { blockers: null, reason: "waiting for a stored reading" }),
    request("DEMO-12", { reason: "parked" }),
    request("DEMO-13"),
    request("DEMO-14"),
  ];
  const outcome = {
    merged: true,
    ticket: { id: "DEMO-7" },
    warnings: [],
    unblocked: {
      ready: requests.map((r) => ({ id: r.ticket, readyForAgent: r.ticket !== "DEMO-14" })),
      parked: [],
      nowWaitsOn: [],
    },
  } as unknown as MergeOutcome;
  const fleet = { deferredLaunches: async () => requests } as Fleet;
  const launched: string[] = [];
  const launch = async (r: DeferredLaunch) => {
    launched.push(r.ticket);
    if (r.ticket === "DEMO-13") throw new Error("CANARY_private_failure");
    return `Launched ${r.ticket}\n`;
  };
  const result = await launchDeferredAfterMerge(outcome, config, fleet, launch);
  expect(launched).toEqual(["DEMO-9", "DEMO-13"]);
  expect(result.map((r) => [r.ticket, r.status])).toEqual([
    ["DEMO-9", "launched"],
    ["DEMO-13", "failed"],
    ["DEMO-14", "manual"],
  ]);
  expect(outcome.warnings.join(" ")).toContain("Request #1 stays pending");
  expect(outcome.warnings.join(" ")).not.toContain("CANARY");
  const guidedConfig = {
    ...config,
    conductor: {
      ...config.conductor,
      profiles: {
        ...config.conductor.profiles,
        backend: { ...config.conductor.profiles.backend!, runtime: "claude-code" as const },
      },
    },
  };
  requests[0]!.command = "armada launch DEMO-9 --profile backend --reason 'saved reason'";
  const guided = await launchDeferredAfterMerge(outcome, guidedConfig, fleet, launch);
  expect(guided[0]).toMatchObject({
    status: "manual",
    command: "armada brief DEMO-9 --profile backend --reason 'saved reason' --prompt",
  });
  expect(launched).toEqual(["DEMO-9", "DEMO-13"]);
  expect(await launchDeferredAfterMerge({ ...outcome, merged: false }, config, fleet, launch)).toEqual([]);
  expect(await launchDeferredAfterMerge({ ...outcome, ticket: null }, config, fleet, launch)).toEqual([]);
});
