import { expect, test } from "bun:test";
import * as core from "@armada/core/server";
import type { BoatProvider } from "@armada/provider-boat";
import { createBoatOrchestratorRecovery } from "../src/orchestrator-boat-recovery.ts";
import { OrchestratorRuntimeStore } from "../src/orchestrator-runtime-store.ts";
import { database, ENCRYPTION_KEY, fakeBoat } from "./support.ts";

// Recovery's primary contract: owner-only retirement fences a later incarnation,
// survives ambiguous archival, and replays without touching compute after success.
test.each(["cloud_retry", "native_unavailable", "native_archived", "legacy_resume_message"] as const)(
  "Boat retirement %s fences a later incarnation and unsafe output",
  async (mode) => {
    const { db, people: p } = await database();
    const sql: core.Sql = {
      query: (q, v) => db.query(q, v),
      transaction: (work) => db.transaction((tx) => work({ query: (q, v) => tx.query(q, v) })),
    };
    try {
      const golden = (await core.createSqlGoldenStore(sql).list(p.org)).find((g) => g.name === "shared")!;
      const accountId = crypto.randomUUID();
      if (mode === "native_archived")
        await sql.query(
          `insert into credentials(id,scope,owner_id,kind,value_enc) values($1,'user',$2,'codex_auth',$3)`,
          [accountId, p.owner, await core.encryptSecret("synthetic-native-auth", ENCRYPTION_KEY)],
        );
      const store = new OrchestratorRuntimeStore(sql, core.reserveOrchestratorOperation);
      const creation = await store.create({
        ownerId: p.owner,
        key: "retire-create",
        skillRevision: "a".repeat(40),
        configuration: {
          version: 1,
          orgId: p.org,
          name: "retirement",
          goldenId: golden.id,
          provider: "boat",
          harness: "codex",
          model: "gpt-6.1-sol",
          modelAccountId: accountId,
        },
      });
      const saved = await core.createSqlSandboxStore(sql).insert({
        id: crypto.randomUUID(),
        ...(mode === "native_archived" ? { credentialId: accountId, credentialVersion: 1 } : {}),
        orgId: p.org,
        ownerId: p.owner,
        goldenId: golden.id,
        provider: "boat",
        providerSandboxId: crypto.randomUUID(),
        model: "gpt-6.1-sol",
        reasoningEffort: "high",
        harness: "codex",
        status: "ready",
        visibility: "private",
      });
      await sql.query(`update public.orchestrators set sandbox_id=$2,state='ready' where id=$1`, [
        creation.identity.id,
        saved.id,
      ]);
      await sql.query(
        `update public.sandboxes set lifecycle_generation=2,orchestrator_native_generation='boot-2' where id=$1`,
        [saved.id],
      );
      await sql.query(`update public.orchestrator_operations set state='succeeded' where id=$1`, [
        creation.operation.id,
      ]);
      if (mode === "legacy_resume_message") {
        const sent = await core.reserveOrchestratorOperation(sql, {
          orchestratorId: creation.identity.id,
          actorId: p.owner,
          action: "message",
          key: "sent",
          digest: "1".repeat(64),
          expectedRevision: 1,
        });
        await sql.query(`update public.orchestrator_operations set state='succeeded' where id=$1`, [sent.id]);
      }
      const stop = await core.reserveOrchestratorOperation(sql, {
        orchestratorId: creation.identity.id,
        actorId: p.owner,
        action: "stop",
        key: "ambiguous-stop",
        digest: "0".repeat(64),
        expectedRevision: mode === "legacy_resume_message" ? 2 : 1,
      });
      let ambiguousId = stop.id;
      if (mode === "legacy_resume_message") {
        await sql.query(`update public.orchestrator_operations set state='succeeded' where id=$1`, [stop.id]);
        const resumed = await core.reserveOrchestratorOperation(sql, {
          orchestratorId: creation.identity.id,
          actorId: p.owner,
          action: "resume",
          key: "failed-resume",
          digest: "2".repeat(64),
          expectedRevision: 3,
        });
        await sql.query(
          `update public.orchestrator_operations set state='failed',error_code='boat_conversation_unavailable' where id=$1`,
          [resumed.id],
        );
        const ambiguous = await core.reserveOrchestratorOperation(sql, {
          orchestratorId: creation.identity.id,
          actorId: p.owner,
          action: "message",
          key: "uncertain-message",
          digest: "3".repeat(64),
          expectedRevision: 4,
        });
        ambiguousId = ambiguous.id;
        await sql.query(
          `update public.orchestrator_runtime set continuity='lost',blocked_reason='runtime_uncertain' where orchestrator_id=$1`,
          [creation.identity.id],
        );
      }
      await sql.query(
        `update public.orchestrator_operations set state='uncertain',error_code='runtime_uncertain' where id=$1`,
        [ambiguousId],
      );
      await sql.query(`update public.orchestrators set state='blocked' where id=$1`, [creation.identity.id]);
      if (mode !== "cloud_retry")
        await sql.query(
          `update public.orchestrator_runtime set conversation_id='native-conversation' where orchestrator_id=$1`,
          [creation.identity.id],
        );
      const placement = fakeBoat();
      let fail = true,
        calls = 0,
        stopped = mode === "native_archived";
      const provider = {
        ...placement.provider,
        get: async () => ({
          id: saved.providerSandboxId,
          name: "retire",
          providerState: stopped ? "stopped" : "ready",
          state: stopped ? ("stopped" as const) : ("ready" as const),
          labels: {},
        }),
        resumeBestEffort: async () => {},
        conversations: async () => [],
        events: async () => {
          throw Error("Unsynchronized native history must never be read");
        },
        ...(mode === "native_unavailable"
          ? {
              retireBestEffort: async () => {
                stopped = true;
              },
            }
          : {}),
        stopBestEffort: async () => {
          if (mode === "legacy_resume_message") {
            const fenced = (
              await sql.query<{
                runtime_result: { history?: string };
                stop_requested_at: unknown;
                authority_epoch: number;
              }>(
                `select p.runtime_result,s.stop_requested_at,o.authority_epoch from public.orchestrator_operations p join public.orchestrators o on o.id=p.orchestrator_id join public.sandboxes s on s.id=o.sandbox_id where p.orchestrator_id=$1 and p.idempotency_key='retire'`,
                [creation.identity.id],
              )
            ).rows[0]!;
            expect(fenced.runtime_result.history).toBe("withheld");
            expect(fenced.stop_requested_at).not.toBeNull();
            expect(Number(fenced.authority_epoch)).toBeGreaterThan(0);
          }
          calls++;
          if ((fail && mode !== "legacy_resume_message") || mode === "native_unavailable")
            throw Error("native SSH unavailable or archival ambiguous");
          stopped = true;
        },
      } as BoatProvider;
      const recover = createBoatOrchestratorRecovery(sql, { resolve: async () => provider });
      const input = {
        ownerId: p.owner,
        orgId: p.org,
        id: creation.identity.id,
        expectedRevision: mode === "legacy_resume_message" ? 5 : 2,
        key: "retire",
      };
      await expect(recover({ ...input, ownerId: p.member })).rejects.toThrow();
      expect(calls).toBe(0);
      if (mode === "legacy_resume_message") {
        await expect(recover({ ...input, expectedRevision: 4 })).rejects.toThrow();
        await sql.query(
          `update public.orchestrator_operations set error_code='runtime_uncertain' where orchestrator_id=$1 and action='resume'`,
          [creation.identity.id],
        );
        await expect(recover(input)).rejects.toThrow();
        expect(calls).toBe(0);
        await sql.query(
          `update public.orchestrator_operations set error_code='boat_conversation_unavailable' where orchestrator_id=$1 and action='resume'`,
          [creation.identity.id],
        );
      }
      expect((await recover(input)).state).toBe(mode !== "cloud_retry" ? "succeeded" : "uncertain");
      fail = false;
      expect((await recover(input)).state).toBe("succeeded");
      expect((await recover(input)).state).toBe("succeeded");
      expect(calls).toBe(mode === "native_archived" ? 0 : mode === "cloud_retry" ? 2 : 1);
      if (mode === "legacy_resume_message") {
        expect(
          (await sql.query(`select state,error_code from public.orchestrator_operations where id=$1`, [ambiguousId]))
            .rows[0],
        ).toMatchObject({ state: "failed", error_code: "message_recovered_terminated" });
      }
      if (mode !== "cloud_retry") {
        const receipt = (
          await sql.query<{ runtime_result: { history?: string } }>(
            `select runtime_result from public.orchestrator_operations where orchestrator_id=$1 and idempotency_key='retire'`,
            [creation.identity.id],
          )
        ).rows[0]!;
        expect(receipt.runtime_result.history).toBe("withheld");
        const cursor = (
          await sql.query<{ provider_cursor: string | null }>(
            `select provider_cursor from public.orchestrator_runtime where orchestrator_id=$1`,
            [creation.identity.id],
          )
        ).rows[0]!;
        expect(cursor.provider_cursor).toBeNull();
      }
      const row = (
        await sql.query<{ status: string; stop_requested_at: unknown; lifecycle_generation: number }>(
          `select status,stop_requested_at,lifecycle_generation from public.sandboxes where id=$1`,
          [saved.id],
        )
      ).rows[0]!;
      expect(row.status).toBe("stopped");
      expect(row.stop_requested_at).not.toBeNull();
      expect(Number(row.lifecycle_generation)).toBe(2);
      await expect(recover({ ...input, key: "different-key" })).rejects.toThrow();
    } finally {
      await db.close();
    }
  },
  // A cold PGlite boot applies the full migration set; allow CPU-contended CI startup.
  15_000,
);
