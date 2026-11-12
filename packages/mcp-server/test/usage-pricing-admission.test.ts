import { expect, test } from "bun:test";
import {
  createSqlGoldenStore,
  createSqlVaultStore,
  encryptSecret,
  launchSandbox,
  type Provider,
} from "@armada/core/server";
import { createSqlData } from "../src/data.ts";
import { launchCredentials } from "../src/launch-credentials.ts";
import { database, ENCRYPTION_KEY, fakeBoat, SECRETS } from "./support.ts";

// Real credential resolution -> launch -> authorized SQL admission; provider alone is a wire-free fake.
test("Modal freezes a secret-free credential/catalog context before inference and cannot reprice it", async () => {
  const { db, people: p } = await database();
  try {
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
    const stores = {
      goldens: createSqlGoldenStore(db),
      sandboxes: createSqlData(db)({
        userId: p.owner,
        via: "service",
        orgs: [{ orgId: p.org, role: "member" }],
      }).sandboxes,
      credentials,
    };
    let admitted: unknown;
    let prompts = 0;
    const fake = fakeBoat();
    const provider: Provider = {
      ...fake.provider,
      id: "modal",
      async prompt(request) {
        prompts++;
        admitted = (await db.query<{ context: unknown }>("select context from sandbox_usage_pricing")).rows[0]?.context;
        expect(admitted).toMatchObject({
          schemaVersion: 1,
          provider: "anthropic",
          basis: "api_equivalent",
          customEndpoint: false,
        });
        return fake.provider.prompt(request);
      },
    };
    const result = await launchSandbox(provider, stores, actor, {
      golden: "priced-modal",
      harness: "claude",
      prompt: "Reply OK",
    });
    expect(admitted).toBeDefined();
    expect(JSON.stringify(admitted)).not.toContain(SECRETS.ownerClaude);
    const context = (await credentials.resolve(actor, "claude")).usagePricing!;
    expect(admitted).toMatchObject({
      credentialId: context.credentialId,
      credentialVersion: context.credentialVersion,
      catalogRevision: context.catalogRevision,
      prices: { "claude-sonnet-5-5": { rates: { input: "2", output: "10" } } },
    });
    await stores.sandboxes.recordUsagePricingContext!(result.sandbox.id, {
      ...context,
      basis: "estimated",
      prices: {},
    });
    expect(
      (
        await db.query<{ context: unknown }>("select context from sandbox_usage_pricing where sandbox_id=$1", [
          result.sandbox.id,
        ])
      ).rows[0]?.context,
    ).toEqual(admitted);
    await expect(
      db.query("update sandbox_usage_pricing set context='{}'::jsonb where sandbox_id=$1", [result.sandbox.id]),
    ).rejects.toThrow("immutable");
    await expect(
      launchSandbox(
        provider,
        {
          ...stores,
          sandboxes: {
            ...stores.sandboxes,
            async recordUsagePricingContext() {
              throw Error("price admission failed");
            },
          },
        },
        actor,
        { golden: "priced-modal", harness: "claude", prompt: "Must not run" },
      ),
    ).rejects.toThrow("price admission failed");
    expect(prompts).toBe(1);
    expect(
      (
        await db.query<{ status: string; activity_lease_id: string | null; status_reason: string }>(
          "select status,activity_lease_id,status_reason from sandboxes where golden_id=$1 and id<>$2",
          [result.sandbox.goldenId, result.sandbox.id],
        )
      ).rows[0],
    ).toMatchObject({
      status: "failed",
      activity_lease_id: null,
      status_reason: expect.stringContaining("price admission failed"),
    });
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
