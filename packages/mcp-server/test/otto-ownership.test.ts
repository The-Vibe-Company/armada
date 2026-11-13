import { afterAll, expect, test } from "bun:test";
import type { AgentEvent, OttoOrphan, OttoPage, OttoResource } from "@armada/core";
import { encryptSecret, type Sql } from "@armada/core/server";
import { createOttoApi } from "../src/otto/api.ts";
import { database, ENCRYPTION_KEY } from "./support.ts";

const shared = database();
afterAll(async () => (await shared).db.close());
const NOW = new Date("2026-11-12T12:00:00Z"),
  SHA = "a".repeat(40),
  OLD = "b".repeat(40);
async function fixture() {
  const { db, people } = await shared,
    org = crypto.randomUUID(),
    golden = crypto.randomUUID();
  const repository = "example/owners";
  await db.query("insert into orgs(id,name) values($1,$2)", [org, org]);
  await db.query("insert into members(org_id,user_id,role) values($1,$2,'member')", [org, people.owner]);
  await db.query(
    "insert into goldens(id,org_id,owner_id,name,visibility,config) values($1,$2,$3,'owner-fixture','org','{}')",
    [golden, org, people.owner],
  );
  const sql: Sql = { query: (q, p) => db.query(q, p) };
  const fact = async (
    subject: string,
    kind: string,
    evidence: unknown,
    at = NOW,
    value = "true",
    completeness = "complete",
  ) =>
    db.query(
      `insert into otto_facts(org_id,repository,subject,kind,value,source,source_id,completeness,evidence,observed_at) values($1,$2,$3,$4,$5,'test.observed',$6,$7,$8::jsonb,$9)`,
      [org, repository, subject, kind, value, crypto.randomUUID(), completeness, JSON.stringify(evidence), at],
    );
  const pr = async (sha = SHA, at = NOW) =>
    fact(
      "pr:42",
      "pr.open",
      { number: 42, title: "Ownership", state: "open", head: { repo: repository, ref: "codex/42-work", sha } },
      at,
    );
  const inventory = async (numbers = [42], at = NOW) => fact("repository", "repository.open_prs", { numbers }, at);
  const sandbox = async (branch = "codex/42-work") => {
    const id = crypto.randomUUID();
    await db.query(
      `insert into sandboxes(id,org_id,golden_id,owner_id,boat_id,harness,status,last_observed_at,resource_project,task_prompt_id) values($1::uuid,$2,$3,$4,$1::text,'codex','ready',$5,$6::jsonb,'p1')`,
      [
        id,
        org,
        golden,
        people.owner,
        NOW,
        JSON.stringify({ version: 1, url: `https://github.com/${repository}.git`, branch, dir: "web" }),
      ],
    );
    return id;
  };
  const prompt = async (id: string, status: "running" | "finished", at: Date, seq: number, text = "codex/42-work") => {
    const event: AgentEvent = { id: String(seq), kind: "prompt", status, text, at: at.getTime(), promptId: "p1" };
    await db.query("insert into runtime_events(sandbox_id,sequence,epoch,event_enc) values($1,$2,1,$3)", [
      id,
      seq,
      await encryptSecret(JSON.stringify(event), ENCRYPTION_KEY),
    ]);
  };
  const get = async <T>(view: string, now = NOW, extra = "") => {
    const api = createOttoApi(
      sql,
      { orgId: org, repository },
      async () => ({
        ok: true,
        caller: { userId: people.owner, orgs: [{ orgId: org, role: "member" }], via: "service" },
      }),
      () => now,
      ENCRYPTION_KEY,
    );
    const response = await api(new Request(`https://armada.example/api/v1/otto/${view}?org_id=${org}${extra}`));
    if (!response || response.status !== 200) throw Error(`otto_api_${response?.status}: ${await response?.text()}`);
    return (await response.json()) as OttoPage<T>;
  };
  return { db, org, people, repository, fact, pr, inventory, sandbox, prompt, get };
}

test("branch match is only candidate; exact-head report confirms, ambiguity and stale evidence remain unknown", async () => {
  const f = await fixture();
  await f.pr();
  await f.inventory();
  const id = await f.sandbox();
  await f.prompt(id, "running", new Date(NOW.getTime() - 60_000), 1);
  const state = async (now = NOW) =>
    (await f.get<OttoResource>("resources", now)).items.find((r) => r.kind === "pr")?.owner.state;
  expect(await state()).toBe("candidate");
  await f.db.query("update sandboxes set task_outcome=$2::jsonb where id=$1", [
    id,
    JSON.stringify({ state: "ready", prNumber: 42, headSha: SHA }),
  ]);
  expect(await state()).toBe("owned");
  expect(await state(new Date(NOW.getTime() + 600_001))).toBe("unknown");
  const other = await f.sandbox();
  await f.prompt(other, "running", new Date(NOW.getTime() - 30_000), 1);
  expect(await state()).toBe("unknown");
});

test("head movement during a running turn confirms ownership; idle failure detection survives recovery and UTC day rollover", async () => {
  const f = await fixture();
  const id = await f.sandbox();
  await f.prompt(id, "running", new Date(NOW.getTime() - 90_000), 1);
  await f.pr(OLD, new Date(NOW.getTime() - 80_000));
  await f.pr(SHA, new Date(NOW.getTime() - 40_000));
  await f.inventory();
  await f.prompt(id, "finished", new Date(NOW.getTime() - 20_000), 2);
  // A failure for a different SHA must not produce an idle-owner orphan.
  await f.fact("pr:42", "pr.work.required_check", { headSha: OLD }, NOW);
  expect((await f.get<OttoOrphan>("orphans")).items.filter((o) => o.state === "orphan")).toHaveLength(0);
  await f.fact("pr:42", "pr.work.required_check", { headSha: SHA }, new Date(NOW.getTime() + 1));
  const when = new Date(NOW.getTime() + 2);
  const first = (await f.get<OttoOrphan>("orphans", when)).items.find((o) => o.state === "orphan");
  expect(first).toMatchObject({ reason: "idle_owner_needs_work", day: "2026-11-12", current: true });
  expect(first?.resource.owner).toMatchObject({ state: "owned", confirmation: "confirmed", sandboxId: id });
  await f.prompt(id, "running", new Date(NOW.getTime() + 5_000), 3);
  await f.db.query("update sandboxes set last_observed_at=$2 where id=$1", [id, new Date(NOW.getTime() + 5_000)]);
  const recovered = (await f.get<OttoOrphan>("orphans", new Date(NOW.getTime() + 10_000))).items.find(
    (o) => o.state === "orphan",
  );
  expect(recovered?.current).toBe(false);
  expect(recovered?.firstSeenAt).toBe(first?.firstSeenAt);
  const history = await f.get<OttoOrphan>("orphans", new Date("2026-11-13T00:00:01Z"), "&day=2026-11-12");
  expect(history.items[0]?.day).toBe("2026-11-12");
});

test("complete DB fleet detects an unowned PR and a live sandbox without a task, without guessing external workstation owners", async () => {
  const f = await fixture();
  await f.pr();
  await f.inventory();
  expect((await f.get<OttoOrphan>("orphans")).items[0]).toMatchObject({
    state: "orphan",
    reason: "pr_without_live_owner",
  });
  const id = await f.sandbox("maintenance");
  await f.prompt(id, "running", new Date(NOW.getTime() - 1000), 1, "maintenance");
  const orphans = (await f.get<OttoOrphan>("orphans")).items;
  expect(orphans.some((o) => o.reason === "live_sandbox_without_task_or_pr" && o.state === "orphan")).toBe(true);
  const summary = await f.get<{ fleetCoverage: string; notObservable: string[] }>("summary");
  expect(summary.items[0]).toMatchObject({
    fleetCoverage: "armada_database",
    notObservable: ["external_workstations"],
  });
});

test("re-observing an unchanged head during a turn is not evidence that it moved during that turn", async () => {
  const f = await fixture(),
    id = await f.sandbox();
  await f.pr(OLD, new Date(NOW.getTime() - 120_000));
  await f.pr(SHA, new Date(NOW.getTime() - 100_000));
  await f.prompt(id, "running", new Date(NOW.getTime() - 60_000), 1);
  await f.pr(SHA, new Date(NOW.getTime() - 10_000));
  await f.inventory();
  const pr = (await f.get<OttoResource>("resources")).items.find((r) => r.kind === "pr");
  expect(pr?.owner.state).toBe("candidate");
});

test("a confirmed owner recorded stopped in the DB is not live; old unknown provider state does not resurrect it", async () => {
  const f = await fixture(),
    id = await f.sandbox();
  await f.pr();
  await f.inventory();
  await f.db.query(
    "update sandboxes set status='stopped',stopped_at=$2,last_observed_at=$2,task_outcome=$3::jsonb where id=$1",
    [id, new Date(NOW.getTime() - 3_600_000), JSON.stringify({ state: "ready", prNumber: 42, headSha: SHA })],
  );
  const orphan = (await f.get<OttoOrphan>("orphans")).items.find((o) => o.resource.kind === "pr");
  expect(orphan).toMatchObject({ state: "orphan", reason: "pr_without_live_owner", current: true });
});
