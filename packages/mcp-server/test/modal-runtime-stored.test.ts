import { expect, spyOn, test } from "bun:test";
import { createSqlVaultStore, encryptSecret, type ProviderTarget, type Sql } from "@armada/core/server";
import { createSqlModalStore, type Scope } from "@armada/provider-modal";
import { AppService } from "modal";
import { createSqlData } from "../src/data.ts";
import { createModalIntegration } from "../src/modal-integration.ts";
import { createRuntimeEnrolments } from "../src/runtime-enrolment.ts";
import { createRuntimeEvents } from "../src/runtime-events.ts";
import { rowOnlyDatabase } from "./row-only-database.ts";
import { ENCRYPTION_KEY } from "./support.ts";

const sharedDatabase = rowOnlyDatabase();

// Production stored-provider composition must select the common archive before
// imposing its read-only proxy. The lower serving-factory test cannot cover this.
test("Modal stored observations route stopped dial-out answers through the archive without cloud access", async () => {
  const { db, people } = await sharedDatabase();
  const apps = spyOn(AppService.prototype, "fromName").mockImplementation(async () => {
    throw Error("Stored observations must not access the Modal App");
  });
  try {
    const sql: Sql = {
      query: (q, v) => db.query(q, v),
      transaction: (work) => db.transaction((tx) => work({ query: (q, v) => tx.query(q, v) })),
    };
    const binding = { workspace: "workspace", environment: "main", appId: "ap-stored-runtime" };
    await db.query(
      "insert into modal_server_apps(org_id,authority,authority_scope,authority_owner_id,app_name,app_id,environment) values($1,$2,'org',$1,'stored-app',$3,'main')",
      [people.org, `org:${people.org}`, binding.appId],
    );
    await db.query("insert into credentials(scope,owner_id,kind,value_enc) values('org',$1,'modal',$2)", [
      people.org,
      await encryptSecret(
        JSON.stringify({ tokenId: "ak-storedfixture", tokenSecret: "as-storedfixture" }),
        ENCRYPTION_KEY,
      ),
    ]);
    const golden = (
      await db.query<{ id: string }>(
        `insert into goldens(org_id,owner_id,name,visibility,provider,provider_sandbox_id,provider_snapshot_id,modal_workspace,modal_environment,modal_app_id,config)
         values($1,$2,'stored-dialout','private','modal','master','image',$3,$4,$5,'{"repos":[],"init":[]}') returning id`,
        [people.org, people.owner, binding.workspace, binding.environment, binding.appId],
      )
    ).rows[0]!;
    const caller = {
      userId: people.owner,
      orgs: [{ orgId: people.org, role: "member" as const }],
      via: "service" as const,
    };
    const sandbox = await createSqlData(sql)(caller).sandboxes.insert({
      id: crypto.randomUUID(),
      provider: "modal",
      runtimeTransport: "dialout",
      providerSandboxId: "modal-stored-host",
      goldenId: golden.id,
      orgId: people.org,
      ownerId: people.owner,
      harness: "codex",
      status: "starting",
      activityLeaseId: crypto.randomUUID(),
      model: "gpt-5.4",
      reasoningEffort: "high",
    });
    const scope: Scope = { orgId: people.org, userId: people.owner, visibility: "private", binding };
    await createSqlModalStore(sql, scope).reserve("stored-host", {
      info: { id: sandbox.providerSandboxId, name: "host", state: "stopped", providerState: "stopped", labels: {} },
      phase: "stopped",
      generation: 1,
      commonRuntime: true,
      golden: false,
      ttlSeconds: 900,
      physicalName: "never-contacted",
      managementAuthority: { credentialScope: "org", credentialOwnerId: people.org },
    });
    const authority = createRuntimeEnrolments(sql, ENCRYPTION_KEY);
    const enrolled = await authority.enrol(
      (await authority.issue({ sandboxId: sandbox.id, ownerId: people.owner, configuration: {} })).enrolmentToken,
    );
    await db.query(
      "update sandboxes set status='running',lifecycle_generation=lifecycle_generation+1,activity_lease_id=null,activity_until=null,task_prompt_id='stored-prompt' where id=$1",
      [sandbox.id],
    );
    await createRuntimeEvents(authority, ENCRYPTION_KEY).append(enrolled.runtimeToken, enrolled.epoch, {
      sandboxId: sandbox.id,
      generation: enrolled.epoch,
      events: [
        {
          sequence: 1,
          event: {
            id: "answer",
            at: 1,
            kind: "message",
            promptId: "stored-prompt",
            text: "MODAL_ARCHIVED_ANSWER",
            partial: false,
            tools: [],
          },
        },
        {
          sequence: 2,
          event: {
            id: "finished",
            at: 2,
            kind: "prompt",
            promptId: "stored-prompt",
            text: "reply",
            status: "finished",
          },
        },
      ],
    });
    await db.query("update sandboxes set status='stopped',stopped_at=now() where id=$1", [sandbox.id]);
    const integration = await createModalIntegration({
      sql,
      vault: createSqlVaultStore(sql),
      encryptionKey: ENCRYPTION_KEY,
      publicUrl: "https://armada.test",
    });
    const target: ProviderTarget = {
      id: sandbox.id,
      provider: "modal",
      runtimeTransport: "dialout",
      orgId: people.org,
      visibility: "private",
      modal: binding,
    };
    const reader = await integration.storedProviderFor(target, { userId: people.owner });
    expect(await reader.events({ sandboxId: sandbox.providerSandboxId })).toMatchObject({
      source: "armada-runtime",
      events: [{ text: "MODAL_ARCHIVED_ANSWER" }, { status: "finished" }],
    });
    expect(await reader.getPrompt({ sandboxId: sandbox.providerSandboxId, promptId: "stored-prompt" })).toMatchObject({
      promptId: "stored-prompt",
      status: "finished",
      done: true,
    });
    expect(await reader.get(sandbox.providerSandboxId)).toMatchObject({ state: "stopped" });
    expect(() => reader.stop({ sandboxId: sandbox.providerSandboxId })).toThrow(
      "Stored observations cannot perform live operations",
    );
    expect(apps).not.toHaveBeenCalled();
  } finally {
    apps.mockRestore();
  }
});
