import { expect, test } from "bun:test";
import type { Sql, TurnTokenUsage } from "@armada/core";
import { createSqlSandboxStore, createSqlVaultStore, encryptSecret } from "@armada/core/server";
import { createSqlData } from "../src/data.ts";
import { launchCredentials } from "../src/launch-credentials.ts";
import { createSandboxAccountChange } from "../src/sandbox-account-change.ts";
import { rowOnlyDatabase } from "./row-only-database.ts";
import { ENCRYPTION_KEY } from "./support.ts";

const database = rowOnlyDatabase();
// Actual migrated storage owns atomic pin/book replacement and delayed historical observation provenance.
test("account changes price new turns under the subscription without rewriting or misattributing old API turns", async () => {
  const { db, people } = await database();
  const sql: Sql = {
    query: (q, v) => db.query(q, v),
    transaction: (work) => db.transaction((tx) => work({ query: (q, v) => tx.query(q, v) })),
  };
  const oldAccount = crypto.randomUUID(),
    subscription = crypto.randomUUID(),
    id = crypto.randomUUID();
  await db.query(
    `insert into credentials(id,scope,owner_id,kind,name,value_enc,version)
    values($1,'user',$3,'openai','API',$4,1),($2,'user',$3,'codex_auth','Subscription',$5,1)`,
    [
      oldAccount,
      subscription,
      people.owner,
      await encryptSecret("offline-api-key", ENCRYPTION_KEY),
      await encryptSecret(
        JSON.stringify({
          tokens: { access_token: "offline-access", refresh_token: "offline-refresh", account_id: "offline-account" },
        }),
        ENCRYPTION_KEY,
      ),
    ],
  );
  await db.query(
    `insert into sandboxes(id,golden_id,org_id,owner_id,provider,provider_sandbox_id,harness,status,
    boat_runtime,credential_id,credential_version,stopped_at,expires_at,model,reasoning_effort)
    select $1,id,org_id,owner_id,'boat','pricing-rebind','codex','stopped',true,$3,1,now(),now()+interval '1 hour','gpt-6.1-sol','high'
    from goldens where owner_id=$2 and name='mine'`,
    [id, people.owner, oldAccount],
  );
  const caller = {
    userId: people.owner,
    orgs: [{ orgId: people.org, role: "member" as const }],
    via: "supabase" as const,
  };
  const actor = { userId: people.owner, orgId: people.org, role: "member" as const };
  const credentials = launchCredentials(createSqlVaultStore(sql), ENCRYPTION_KEY);
  const evidence = createSqlSandboxStore(sql, { turnModels: true });
  const store = createSqlData(sql)(caller).sandboxes;
  const old = await credentials.resolve(actor, "codex", oldAccount);
  if (!old.usagePricing) throw Error("missing original pricing book");
  await evidence.recordUsagePricingContext!(id, old.usagePricing);
  await evidence.recordTurnModel!(id, "old", "gpt-6.1-sol");
  await evidence.recordTurnModel!(id, "old-delayed", "gpt-6.1-sol");
  const usage = (promptId: string): TurnTokenUsage => ({
    promptId,
    model: "gpt-6.1-sol",
    inputTokens: 100,
    outputTokens: 10,
    cachedTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
  });
  const record = async (promptId: string, count: number) => {
    const turn = usage(promptId);
    await store.recordUsage!(id, { turnCount: count, turns: [turn] }, { observations: [turn] });
  };
  await record("old", 1);
  const before = (
    await db.query<{ usage_turns: { turns: TurnTokenUsage[] } }>("select usage_turns from sandboxes where id=$1", [id])
  ).rows[0]!.usage_turns.turns[0];
  await createSandboxAccountChange(sql, credentials, async () => {
    throw Error("not legacy");
  })(caller, { id, credentialId: subscription });
  await evidence.recordTurnModel!(id, "new", "gpt-6.1-sol");
  await record("new", 2);
  await record("old-delayed", 3);
  const after = (
    await db.query<{ usage_turns: { turns: TurnTokenUsage[] } }>("select usage_turns from sandboxes where id=$1", [id])
  ).rows[0]!.usage_turns.turns;
  expect(after.find((turn) => turn.promptId === "old")).toEqual(before);
  expect(after.find((turn) => turn.promptId === "new")?.pricing).toMatchObject({
    credentialId: subscription,
    basis: "api_equivalent",
  });
  expect(after.find((turn) => turn.promptId === "old-delayed")?.pricing).toMatchObject({
    credentialId: oldAccount,
    basis: "estimated",
  });
  // An observation lacking a captured post-switch admission must stay unknown, not inherit either account.
  await record("unadmitted", 4);
  const unknown = (
    await db.query<{ usage_turns: { turns: TurnTokenUsage[] } }>("select usage_turns from sandboxes where id=$1", [id])
  ).rows[0]!.usage_turns.turns;
  expect(unknown.find((turn) => turn.promptId === "unadmitted")?.pricing).toBeNull();
});
