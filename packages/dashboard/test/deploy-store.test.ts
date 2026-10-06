import { afterAll, beforeAll, expect, test } from "bun:test";
import type { Database } from "../lib/db.ts";
import { fleetStore } from "../lib/fleet-store.ts";
import { addOrganizations, tempDatabase } from "./support.ts";

const PROJECT = "deploy-test";
const BASE = Date.parse("2026-04-06T10:00:00Z");
const at = (minutes: number) => new Date(BASE + minutes * 60_000);
let db: Database;

beforeAll(async () => {
  db = await tempDatabase();
  await addOrganizations(db, "deploy-org");
  await fleetStore(db).ensureProject(
    { slug: PROJECT, name: "Deploy test", repository: "acme/deploy-test", programRoot: "DPL-1" },
    at(0),
  );
});
afterAll(() => db.end());

const failure = (sha: string, minute: number, pauseOnFailure = true) => ({
  project: PROJECT,
  target: "preview",
  sha,
  state: "smoke-failed" as const,
  detail: `${sha} output\n${"x".repeat(5000)}`,
  pauseOnFailure,
  at: at(minute),
});

test("persists first observation, caps output, coalesces the pause notice, and keeps terminal retries immutable", async () => {
  const store = fleetStore(db);
  const first = await store.recordDeploy({ ...failure("a", 1) });
  expect(first).toMatchObject({ project: PROJECT, target: "preview", sha: "a", state: "smoke-failed", sequence: 1 });
  expect(new TextEncoder().encode(first.detail).length).toBeLessThanOrEqual(4096);
  expect(first.startedAt).toBe(at(1).toISOString());
  const retry = await store.recordDeploy({ ...failure("a", 2), detail: "retry should not replace terminal output" });
  expect(retry).toEqual(first);
  expect(await store.openHolds(PROJECT)).toHaveLength(1);
  const notices = await store.openInboxItems({ project: PROJECT, recipient: "coordinator" });
  expect(notices).toHaveLength(1);
  expect(notices[0]?.kind).toBe("deploy");
  expect(notices[0]?.body.includes("preview")).toBe(true);
  expect(notices[0]?.body.includes("a")).toBe(true);
  expect(notices[0]?.body.includes("Last output:")).toBe(true);
  expect((await store.deployState(PROJECT, { target: "preview", sha: "a" })).map((row) => row.sha)).toEqual(["a"]);
});

test("pause false still notifies, and healthy clears only an explicitly covered failure", async () => {
  const store = fleetStore(db);
  const failed = await store.recordDeploy({ ...failure("b", 3, false), target: "no-pause" });
  expect(failed.state).toBe("smoke-failed");
  const notices = async () =>
    (await store.openInboxItems({ project: PROJECT, recipient: "coordinator" })).filter(
      (item) => item.kind === "deploy" && item.body.includes("no-pause"),
    );
  const [notice] = await notices();
  expect(notice).toMatchObject({ kind: "deploy", project: PROJECT });
  expect(notice?.body).toContain("no-pause (b)");
  if (!notice) throw new Error("missing no-pause failure notice");
  expect((await store.openHolds(PROJECT)).some((hold) => hold.ref === "no-pause")).toBe(false);
  const healthyWithoutCoverage = await store.recordDeploy({
    project: PROJECT,
    target: "no-pause",
    sha: "c",
    state: "healthy",
    detail: "green",
    pauseOnFailure: true,
    at: at(4),
  });
  expect(healthyWithoutCoverage.state).toBe("healthy");
  expect((await notices()).map((item) => item.id)).toEqual([notice.id]);
  expect((await store.openHolds(PROJECT)).some((hold) => hold.ref === "no-pause")).toBe(false);
  await store.recordDeploy({
    project: PROJECT,
    target: "no-pause",
    sha: "d",
    state: "healthy",
    detail: "green and includes b",
    coveredShas: ["b"],
    pauseOnFailure: true,
    at: at(5),
  });
  expect((await store.openHolds(PROJECT)).some((hold) => hold.ref === "no-pause")).toBe(false);
  expect(await notices()).toEqual([]);
  expect((await store.getInboxItem(PROJECT, notice?.id ?? 0))?.resolvedAt).toBe(at(5).toISOString());
  const remaining = await store.openInboxItems({ project: PROJECT, recipient: "coordinator" });
  expect(remaining).toHaveLength(1);
  expect(remaining[0]?.body).toContain("preview");
});

test("a healthy observation with a newer sequence but no coverage does not suppress a failure", async () => {
  const store = fleetStore(db);
  await store.recordDeploy({
    project: PROJECT,
    target: "stable",
    sha: "failure-not-covered",
    state: "waiting",
    detail: "watching",
    pauseOnFailure: true,
    at: at(6),
  });
  await store.recordDeploy({
    project: PROJECT,
    target: "stable",
    sha: "healthy-newer",
    state: "healthy",
    detail: "green",
    pauseOnFailure: true,
    at: at(7),
  });
  await store.recordDeploy({ ...failure("failure-not-covered", 8), target: "stable" });
  expect((await store.openHolds(PROJECT)).some((hold) => hold.ref === "stable")).toBe(true);
});

test("a repeated healthy row may add ancestry coverage and recover a previously unseen failure", async () => {
  const store = fleetStore(db);
  await store.recordDeploy({
    project: PROJECT,
    target: "enrichment",
    sha: "failed-merge",
    state: "deploy-failed",
    detail: "failed",
    pauseOnFailure: true,
    at: at(9),
  });
  await store.recordDeploy({
    project: PROJECT,
    target: "enrichment",
    sha: "live-merge",
    state: "healthy",
    detail: "healthy before ancestry was known",
    pauseOnFailure: true,
    at: at(10),
  });
  expect((await store.openHolds(PROJECT)).some((hold) => hold.ref === "enrichment")).toBe(true);
  const enriched = await store.recordDeploy({
    project: PROJECT,
    target: "enrichment",
    sha: "live-merge",
    state: "healthy",
    detail: "healthy and includes the failed merge",
    coveredShas: ["failed-merge"],
    pauseOnFailure: true,
    at: at(11),
  });
  expect(enriched.coveredShas).toContain("failed-merge");
  expect((await store.openHolds(PROJECT)).some((hold) => hold.ref === "enrichment")).toBe(false);
});

test("failure and its hold/inbox item roll back together", async () => {
  const isolated = await tempDatabase();
  try {
    const store = fleetStore(isolated);
    await store.ensureProject(
      { slug: "deploy-rollback", name: "Rollback", repository: "acme/rollback", programRoot: "DPL-2" },
      at(0),
    );
    await isolated.query(
      "ALTER TABLE inbox_items ADD CONSTRAINT reject_deploy_test CHECK (kind <> 'deploy') NOT VALID",
    );
    await expect(
      store.recordDeploy({
        project: "deploy-rollback",
        target: "preview",
        sha: "rollback",
        state: "deploy-failed",
        detail: "failed",
        pauseOnFailure: true,
        at: at(8),
      }),
    ).rejects.toThrow();
    expect((await isolated.query("SELECT * FROM deploys")).rows).toHaveLength(0);
    expect((await isolated.query("SELECT * FROM merge_holds")).rows).toHaveLength(0);
    expect((await isolated.query("SELECT * FROM inbox_items")).rows).toHaveLength(0);
  } finally {
    await isolated.end();
  }
});

test("skipped deploys persist without notices, can be retried, and never overwrite a real observation", async () => {
  const store = fleetStore(db);
  const skip = {
    project: PROJECT,
    target: "machine-local",
    sha: "configured-later",
    state: "skipped" as const,
    detail: "skipped (not configured on this machine): DEPLOY_LINK_DIR",
    pauseOnFailure: false,
    at: at(20),
  };
  expect((await store.recordDeploy(skip)).state).toBe("skipped");
  expect((await store.openHolds(PROJECT)).some((h) => h.ref === skip.target)).toBe(false);
  expect(
    (await store.openInboxItems({ project: PROJECT, recipient: "coordinator" })).some((i) =>
      i.body.includes(skip.target),
    ),
  ).toBe(false);
  const waiting = await store.recordDeploy({ ...skip, state: "waiting", detail: "watching", at: at(30) });
  expect(waiting.state).toBe("waiting");
  expect(waiting.startedAt).toBe(at(30).toISOString());
  expect(await store.recordDeploy({ ...skip, at: at(31) })).toEqual(waiting);
  const healthy = await store.recordDeploy({ ...skip, state: "healthy", detail: "healthy", at: at(32) });
  expect(await store.recordDeploy({ ...skip, at: at(33) })).toEqual(healthy);
});

test("not-runnable configuration observations notify atomically, retry with a fresh deadline and preserve real failures", async () => {
  const store = fleetStore(db);
  const local = {
    project: PROJECT,
    target: "local-command",
    sha: "local-a",
    state: "not-runnable" as const,
    detail: "sh: link: set link",
    pauseOnFailure: false,
    at: at(40),
  };
  expect((await store.recordDeploy({ ...local, state: "waiting" })).state).toBe("waiting");
  expect((await store.recordDeploy({ ...local, at: at(41) })).state).toBe("not-runnable");
  await store.recordDeploy({ ...local, at: at(42) });
  const notices = (await store.openInboxItems({ project: PROJECT, recipient: "coordinator" })).filter((i) =>
    i.body.includes(local.target),
  );
  expect(notices).toHaveLength(1);
  expect(notices[0]?.kind).toBe("deploy");
  expect(notices[0]?.body).toContain("not runnable on this machine (configuration)");
  expect(notices[0]?.body).toContain(local.detail);
  expect((await store.openHolds(PROJECT)).filter((h) => h.ref === local.target)).toHaveLength(0);
  const retry = await store.recordDeploy({ ...local, state: "waiting", at: at(45) });
  expect(retry.startedAt).toBe(at(45).toISOString());
  const healthy = await store.recordDeploy({ ...local, state: "healthy", at: at(46) });
  expect(
    (await store.openInboxItems({ project: PROJECT, recipient: "coordinator" })).filter((i) =>
      i.body.includes(local.target),
    ),
  ).toHaveLength(0);
  expect(await store.recordDeploy({ ...local, at: at(47) })).toEqual(healthy);
  const failed = await store.recordDeploy({
    ...local,
    sha: "local-b",
    state: "smoke-failed",
    pauseOnFailure: true,
    detail: "real smoke failure",
    at: at(48),
  });
  expect((await store.openHolds(PROJECT)).filter((h) => h.ref === local.target)).toHaveLength(1);
  expect(await store.recordDeploy({ ...local, sha: "local-b", at: at(49) })).toEqual(failed);
  await store.recordDeploy({ ...local, sha: "local-c", at: at(50) });
  const held = (await store.openInboxItems({ project: PROJECT, recipient: "coordinator" })).filter((i) =>
    i.body.includes(local.target),
  );
  expect(held).toHaveLength(1);
  expect(held[0]?.body).toContain("real smoke failure");
});
