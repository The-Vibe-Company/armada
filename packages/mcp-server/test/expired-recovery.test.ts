import { expect, test } from "bun:test";
import { type Provider, ProviderError } from "@armada/core";
import { createSqlData } from "../src/data.ts";
import { callSharedTool } from "../src/tool-api.ts";
import type { ToolContext } from "../src/tools.ts";
import { rowOnlyDatabase } from "./row-only-database.ts";
import { bunLikeSql } from "./support.ts";

const database = rowOnlyDatabase();

// Shared send admission owns the user-visible recovery result and logical lifetime.
// Adapter recovery/checkpoint behavior stays with provider-modal's tests.
async function fixture(providerId: "boat" | "modal", harness: "claude" | "codex") {
  const { db, people } = await database();
  const id = crypto.randomUUID();
  const recovery = `work_recovery:${id}/${crypto.randomUUID()}`;
  const golden = crypto.randomUUID();
  await db.query(
    `insert into goldens(id,org_id,owner_id,name,visibility,provider,provider_sandbox_id,provider_snapshot_id,
      boat_snapshot_id,modal_workspace,modal_environment,modal_app_id,config)
     values($1,$2,$3,'recovery','org',$4,'source','image',$5,$6,$7,$8,'{"repos":[],"init":[]}')`,
    [
      golden,
      people.org,
      people.owner,
      providerId,
      providerId === "boat" ? `a${"1".repeat(62)}` : null,
      providerId === "modal" ? "workspace" : null,
      providerId === "modal" ? "main" : null,
      providerId === "modal" ? "app" : null,
    ],
  );
  await db.query(
    `insert into sandboxes(id,golden_id,org_id,owner_id,provider,provider_sandbox_id,harness,status,
      conversation_ids,status_reason,stopped_at,expires_at,effective_ttl_seconds,preservation_note,credential_id)
     values($1,$2,$3,$4,$5,'retained',$6,'stopped',array['older','exact_prior'],'expired',now()-interval '1 hour',
      now()-interval '1 hour',120,$7,(select id from credentials where owner_id=$4 and kind='claude_oauth' limit 1))`,
    [id, golden, people.org, people.owner, providerId, harness, `unpushed work preserved at ${recovery}`],
  );
  const caller = {
    via: "service" as const,
    userId: people.owner,
    orgs: [{ orgId: people.org, role: "member" as const }],
  };
  const data = createSqlData(bunLikeSql(db))(caller);
  let submitted: unknown;
  const provider = {
    id: providerId,
    get: async () => ({ id: "retained", state: "stopped", providerState: "stopped" }),
    prompt: async (request: unknown) => {
      submitted = request;
      return {
        promptId: "new_turn",
        conversationId: "exact_prior",
        status: "queued",
        ...(providerId === "boat" ? { resumed: true } : {}),
      };
    },
  } as unknown as Provider;
  const context = {
    caller,
    data,
    provider: async () => provider,
    now: () => new Date(),
    launchCredentials: { resolve: async () => ({ env: {}, secrets: [], codexAuthJson: false }) },
  } as unknown as ToolContext;
  return { db, id, recovery, provider, context, submitted: () => submitted };
}

test.each([
  ["boat", "claude"],
  ["boat", "codex"],
  ["modal", "claude"],
  ["modal", "codex"],
] as const)(
  "retained expired %s/%s sends keep the native conversation and bounded lifetime",
  async (provider, harness) => {
    for (const externallyStopped of [false, true]) {
      const f = await fixture(provider, harness);
      if (externallyStopped)
        await f.db.query("update sandboxes set status='ready',stopped_at=null,status_reason=null where id=$1", [f.id]);
      const before = Date.now();
      await expect(callSharedTool(f.context, "send", { id: f.id, prompt: "recall" })).resolves.toMatchObject({
        id: f.id,
        conversationId: "exact_prior",
        promptId: "new_turn",
      });
      expect(f.submitted()).toMatchObject({ harness, conversationId: "exact_prior" });
      const row = (
        await f.db.query<{ expires_at: Date; status_reason: string | null }>(
          "select expires_at,status_reason from sandboxes where id=$1",
          [f.id],
        )
      ).rows[0]!;
      const deadline = new Date(row.expires_at).getTime();
      expect(deadline).toBeGreaterThanOrEqual(before + 119_000);
      expect(deadline).toBeLessThanOrEqual(Date.now() + 120_000);
      expect(row.status_reason).toBeNull();
    }
  },
);

test("confirmed absent disk/checkpoint is closed with the preserved work reference, including prompt-time loss", async () => {
  for (const provider of ["boat", "modal"] as const) {
    for (const loss of ["read", "prompt", "physical_exit", "stop_fallback"] as const) {
      const f = await fixture(provider, "codex");
      const missing = async () => {
        throw new ProviderError({
          provider,
          code: provider === "modal" ? "sandbox_not_restorable" : "not_found",
          message: "gone",
          retryable: false,
        });
      };
      if (loss === "read") f.provider.get = missing;
      if (loss === "prompt") {
        const get = f.provider.get;
        let reads = 0;
        f.provider.get = async (id) => (++reads === 1 ? get(id) : missing());
        f.provider.prompt = missing;
      }
      if (loss === "physical_exit" || loss === "stop_fallback")
        f.provider.get = async () => ({
          id: "retained",
          name: "retained",
          state: "failed",
          providerState: "exited",
          labels: {},
          ...(loss === "physical_exit"
            ? { physicalExitConfirmed: true }
            : { stopNote: "checkpoint_failed_disk_not_retained" as const }),
        });
      await expect(callSharedTool(f.context, "send", { id: f.id, prompt: "recall" })).rejects.toMatchObject({
        code: "sandbox_not_restorable",
        message: expect.stringContaining(f.recovery),
        status: 409,
      });
      expect(f.submitted()).toBeUndefined();
      expect(
        (await f.db.query<{ preservation_note: string }>("select preservation_note from sandboxes where id=$1", [f.id]))
          .rows[0]?.preservation_note,
      ).toContain(f.recovery);
    }
  }
});

test("conversation absence and transient dispatch failure do not claim the retained disk is lost", async () => {
  for (const code of ["not_found", "unavailable"] as const) {
    const f = await fixture("boat", "claude");
    f.provider.prompt = async () => {
      throw new ProviderError({ provider: "boat", code, message: "refused", retryable: code === "unavailable" });
    };
    await expect(callSharedTool(f.context, "send", { id: f.id, prompt: "recall" })).rejects.toMatchObject({
      code: code === "not_found" ? "not_found" : "outcome_unknown",
    });
  }
});

test("Modal App lookup absence does not claim its retained disk is lost", async () => {
  const f = await fixture("modal", "claude");
  f.provider.get = async () => {
    throw new ProviderError({ provider: "modal", code: "not_found", message: "App not found", retryable: false });
  };
  await expect(callSharedTool(f.context, "send", { id: f.id, prompt: "recall" })).rejects.toMatchObject({
    code: "not_found",
  });
});
