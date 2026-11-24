import { expect, test } from "bun:test";
import { createSqlVaultStore, encryptSecret } from "@armada/core/server";
import { launchCredentials } from "../src/launch-credentials.ts";
import { migratedDatabase } from "./migrated-database.ts";
import { ENCRYPTION_KEY, SECRETS } from "./support.ts";

// Real credential resolution -> launch -> authorized SQL admission; provider alone is a wire-free fake.
test("Modal freezes a secret-free credential/catalog context before inference and cannot reprice it", async () => {
  const db = await migratedDatabase();
  const p = { org: crypto.randomUUID(), owner: crypto.randomUUID() };
  try {
    await db.query("insert into auth.users(id) values($1)", [p.owner]);
    await db.query("insert into orgs(id,name) values($1,'Pricing admission')", [p.org]);
    await db.query("insert into members(org_id,user_id,role) values($1,$2,'member')", [p.org, p.owner]);
    await db.query("insert into credentials(scope,owner_id,kind,value_enc) values('user',$1,'claude_oauth',$2)", [
      p.owner,
      await encryptSecret(SECRETS.ownerClaude, ENCRYPTION_KEY),
    ]);
    await db.query(
      `insert into goldens(org_id,owner_id,name,visibility,provider,provider_sandbox_id,provider_snapshot_id,
      modal_workspace,modal_environment,modal_app_id,config)
      values($1,$2,'priced-modal','private','modal','master','snapshot','workspace','main','ap-pricing',
      '{"repos":[{"url":"https://github.com/acme/web","branch":"main","dir":"web"}],"init":[]}'::jsonb)`,
      [p.org, p.owner],
    );
    const actor = { userId: p.owner, orgId: p.org, role: "member" as const };
    const credentials = launchCredentials(createSqlVaultStore(db), ENCRYPTION_KEY);
    const endpointKey = "synthetic-admission-endpoint-key";
    const customAccount = (
      await db.query<{ id: string }>(
        "insert into credentials(scope,owner_id,kind,value_enc) values('user',$1,'openai',$2) returning id",
        [
          p.owner,
          await encryptSecret(
            JSON.stringify({ apiKey: endpointKey, endpoint: { version: 1, baseUrl: "https://example.invalid/v1" } }),
            ENCRYPTION_KEY,
          ),
        ],
      )
    ).rows[0];
    if (!customAccount) throw Error("Missing custom account fixture");
    const customContext = (await credentials.resolve(actor, "codex", customAccount.id)).usagePricing;
    expect(customContext).toMatchObject({
      customEndpoint: true,
      basis: "estimated",
      credentialId: customAccount.id,
      credentialVersion: 1,
      prices: {},
    });
    expect(JSON.stringify(customContext)).not.toContain(endpointKey);
    expect(JSON.stringify(customContext)).not.toContain("example.invalid");
    const context = (await credentials.resolve(actor, "claude")).usagePricing!;
    expect(context).toMatchObject({
      schemaVersion: 1,
      provider: "anthropic",
      basis: "api_equivalent",
      customEndpoint: false,
      prices: { "claude-sonnet-5-5": { rates: { input: "2", output: "10" } } },
    });
    expect(JSON.stringify(context)).not.toContain(SECRETS.ownerClaude);
    // Main's Claude gateway delivery is likewise private custom pricing, never public Anthropic rates.
    const gatewayKey = "synthetic-admission-gateway-key";
    const gateway = (
      await db.query<{ id: string }>(
        "insert into credentials(scope,owner_id,kind,value_enc) values('user',$1,'anthropic',$2) returning id",
        [
          p.owner,
          await encryptSecret(
            JSON.stringify({
              apiKey: gatewayKey,
              endpoint: { version: 1, baseUrl: "https://gateway.invalid/v1", auth: "api-key" },
            }),
            ENCRYPTION_KEY,
          ),
        ],
      )
    ).rows[0];
    if (!gateway) throw Error("Missing gateway fixture");
    const gatewayContext = (await credentials.resolve(actor, "claude", gateway.id)).usagePricing;
    expect(gatewayContext).toMatchObject({
      provider: "anthropic",
      basis: "estimated",
      customEndpoint: true,
      prices: {},
    });
    expect(JSON.stringify(gatewayContext)).not.toContain(gatewayKey);
    expect(JSON.stringify(gatewayContext)).not.toContain("gateway.invalid");
    await db.query("set role authenticated");
    try {
      await expect(db.query("select context from sandbox_usage_pricing")).rejects.toThrow("permission denied");
    } finally {
      await db.query("reset role");
    }
  } finally {
    await db.close();
  }
});
