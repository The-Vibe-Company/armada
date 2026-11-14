import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexDriver, type DriverEvent } from "@armada/agent-runtime";
import type { AgentEvent } from "@armada/core";
import { createUsagePricingContext } from "@armada/core/server";
import { openMigratedDatabase } from "../../../scripts/test-support/migrated-database.ts";
import recording from "../../agent-runtime/test/fixtures/codex-resume-recorded.json";
import { createSqlData } from "../src/data.ts";
import { createRuntimeEnrolments } from "../src/runtime-enrolment.ts";
import { createRuntimeEvents } from "../src/runtime-events.ts";
import { ENCRYPTION_KEY } from "./support.ts";

// This owns the native child -> encrypted archive -> public status contract.
// Driver unit tests own baseline validation; SQL unit tests own unknown/rollback.
(process.platform === "linux" ? test : test.skip)(
  "recorded Codex first and cold-resumed turns expose their own positive admitted USD in Boat status",
  async () => {
    const db = await openMigratedDatabase();
    const people = { org: crypto.randomUUID(), owner: crypto.randomUUID() };
    const root = await mkdtemp(join(tmpdir(), "runtime-positive-cost-"));
    const drivers: CodexDriver[] = [];
    try {
      // Recorded native usage needs ownership, not unrelated launch credentials.
      await db.query("insert into auth.users(id) values($1)", [people.owner]);
      await db.query("insert into orgs(id,name) values($1,'Positive cost')", [people.org]);
      await db.query("insert into members(org_id,user_id,role) values($1,$2,'member')", [people.org, people.owner]);
      await db.query("insert into goldens(org_id,owner_id,name,visibility) values($1,$2,'positive-source','private')", [
        people.org,
        people.owner,
      ]);
      const id = crypto.randomUUID(),
        credentialId = crypto.randomUUID();
      await db.query(
        `insert into sandboxes(id,golden_id,org_id,owner_id,boat_id,harness,status,boat_runtime)
       select $1,id,org_id,owner_id,'positive-cost','codex','ready',true from goldens where owner_id=$2 and visibility='private' limit 1`,
        [id, people.owner],
      );
      const caller = {
        userId: people.owner,
        via: "service" as const,
        orgs: [{ orgId: people.org, role: "member" as const }],
      };
      const store = createSqlData(db)(caller).sandboxes;
      await store.recordUsagePricingContext!(
        id,
        createUsagePricingContext({
          harness: "codex",
          credentialKind: "openai",
          customEndpoint: false,
          credentialId,
          credentialVersion: 1,
        }),
      );
      const authority = createRuntimeEnrolments(db, ENCRYPTION_KEY);
      const route = createRuntimeEvents(authority, ENCRYPTION_KEY).route;
      let sequence = 0;
      const archived: { sequence: number; event: AgentEvent }[] = [];
      const run = async (resumed: boolean) => {
        const active = await authority.enrol(
          (await authority.issue({ ownerId: people.owner, sandboxId: id, configuration: {} })).enrolmentToken,
        );
        const driver = new CodexDriver({
          executable: join(import.meta.dir, "../../agent-runtime/test/fixtures/recorded-resume.ts"),
          cwd: root,
          env: { PATH: process.env.PATH ?? "/usr/bin:/bin", ARMADA_TEST_ROLLOUT: join(root, "rollout.jsonl") },
        });
        drivers.push(driver);
        const events: DriverEvent[] = [];
        const promptId = resumed ? "after-resume" : "first";
        expect(
          await driver.start({
            request: { sandboxId: id, harness: "codex", text: "Reply OK", model: "gpt-6.1-sol" },
            ...(resumed ? { sessionId: "recorded-thread" } : {}),
            signal: new AbortController().signal,
            session() {},
            emit: (e) => events.push(e),
          }).done,
        ).toBe("finished");
        const usage = events.filter((e) => e.kind === "other" && e.type === "armada/turnUsage");
        expect(usage).toHaveLength(1);
        const event = {
          ...usage[0],
          kind: "other",
          type: "armada/turnUsage",
          id: crypto.randomUUID(),
          promptId,
          at: Date.now(),
        } as AgentEvent;
        archived.push({ sequence: ++sequence, event });
        const upload = () =>
          route(
            new Request("https://armada.example/api/runtime/events", {
              method: "POST",
              headers: { authorization: `Bearer ${active.runtimeToken}`, "x-armada-runtime-epoch": active.epoch },
              body: JSON.stringify({ sandboxId: id, generation: active.epoch, events: archived }),
            }),
          );
        expect((await upload())?.status).toBe(200);
        const status = await store.get(id);
        expect((await upload())?.status).toBe(200);
        expect((await store.get(id))?.usage?.turns).toEqual(status?.usage?.turns);
        return status?.usage;
      };
      const first = await run(false);
      expect(first?.cost).toMatchObject({ usd: "0.032906", unknown: null, unpricedTurns: 0 });
      expect(first?.turns[0]).toMatchObject({
        inputTokens: 13143,
        outputTokens: 5,
        cachedTokens: 0,
        cacheWriteTokens: 13140,
      });
      // Real native rollout accounting gives a cold process the closed prior total,
      // not a synthetic zero baseline or the late pre-turn notification.
      const total = recording.find((e) => e.phase === "fresh" && e.method === "thread/tokenUsage/updated")?.params
        ?.tokenUsage.total;
      if (!total) throw Error("missing native accounting recording");
      await writeFile(
        join(root, "rollout.jsonl"),
        [
          { type: "session_meta", payload: { id: "recorded-thread" } },
          { type: "event_msg", payload: { type: "task_started", turn_id: "recorded-fresh" } },
          {
            type: "event_msg",
            payload: {
              type: "token_count",
              info: {
                total_token_usage: {
                  input_tokens: total.inputTokens,
                  output_tokens: total.outputTokens,
                  cached_input_tokens: total.cachedInputTokens,
                  cache_write_input_tokens: total.cacheWriteInputTokens,
                  reasoning_output_tokens: total.reasoningOutputTokens,
                },
              },
            },
          },
          { type: "event_msg", payload: { type: "task_complete", turn_id: "recorded-fresh" } },
        ]
          .map((e) => JSON.stringify(e))
          .join("\n") + "\n",
      );
      const resumed = await run(true);
      expect(resumed?.cost).toMatchObject({ usd: "0.034326", unknown: null, unpricedTurns: 0 });
      expect(resumed?.turnCount).toBe(2);
      expect(resumed?.turns.find((t) => t.promptId === "after-resume")).toMatchObject({
        inputTokens: 13163,
        outputTokens: 5,
        cachedTokens: 13140,
        cacheWriteTokens: 20,
        pricing: { usd: "0.00142", credentialId, credentialVersion: 1 },
      });
      expect(resumed?.tokenTotals).toMatchObject({
        inputTokens: 26306,
        outputTokens: 10,
        cachedTokens: 13140,
        cacheWriteTokens: 13160,
      });
    } finally {
      await Promise.all(drivers.map((driver) => driver.close()));
      await db.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);
