import { expect, test } from "bun:test";
import { encryptSecret, type Provider } from "@armada/core";
import { openMigratedDatabase } from "../../../scripts/test-support/migrated-database.ts";
import { createRuntimeAgent } from "../src/runtime-agent.ts";
import { createRuntimeProvider } from "../src/runtime-provider.ts";
import { createRuntimeServing } from "../src/runtime-serving.ts";
import { callSharedTool } from "../src/tool-api.ts";
import { runtimeFixture } from "./runtime-fixture.ts";
import { ENCRYPTION_KEY, type People, SECRETS } from "./support.ts";

for (const placement of ["boat", "modal"] as const)
  test(`${placement} control tools reach the enrolled runtime, preserve turn identity and redact bounded exec output without native hooks`, async () => {
    const db = await openMigratedDatabase();
    const people: People = {
      org: crypto.randomUUID(),
      otherOrg: crypto.randomUUID(),
      owner: crypto.randomUUID(),
      member: crypto.randomUUID(),
      admin: crypto.randomUUID(),
    };
    let fixture: Awaited<ReturnType<typeof runtimeFixture>> | undefined;
    try {
      // Control/renewal needs one account and org golden, not the launch credential matrix.
      await db.query("insert into auth.users(id) values($1),($2)", [people.owner, people.member]);
      await db.query("insert into orgs(id,name) values($1,'Runtime controls')", [people.org]);
      await db.query("insert into members(org_id,user_id,role) values($1,$2,'member'),($1,$3,'member')", [
        people.org,
        people.owner,
        people.member,
      ]);
      await db.query(
        "insert into goldens(org_id,owner_id,name,visibility,boat_snapshot_id,config) values($1,$2,'shared','org',$3,$4::jsonb)",
        [people.org, people.owner, `a${"2".repeat(62)}`, JSON.stringify({ repos: [], init: [] })],
      );
      await db.query("insert into credentials(scope,owner_id,kind,value_enc) values('org',$1,'openai',$2)", [
        people.org,
        await encryptSecret(SECRETS.orgOpenai, ENCRYPTION_KEY),
      ]);
      const f = await runtimeFixture({ db, people }, placement);
      fixture = f;
      const agent = createRuntimeAgent(f.bridge, {
        harness: "codex",
        ownerId: f.people.owner,
        sandboxId: f.row.id,
        providerSandboxId: "physical",
        cwd: f.root,
        defaults: { model: "gpt-5.4", reasoningEffort: "high" },
      });
      const provider = createRuntimeProvider({ id: placement } as Provider, "physical", agent, {
        ...agent,
        steer: (request) => agent.steer({ ...request, conversationId: f.first.conversationId }),
      });
      const context = {
        ...f.context,
        provider: async () => provider,
        exposedSecrets: async () => ["PRIVATE_SENTINEL"],
      };
      const output = await callSharedTool(context, "exec", {
        id: f.row.id,
        command: "printf PRIVATE_SENTINEL; printf problem >&2; exit 7",
        cwd: f.root,
      });
      expect(output).toMatchObject({ exitCode: 7, stderr: "problem", timedOut: false });
      expect(JSON.stringify(output)).not.toContain("PRIVATE_SENTINEL");
      const clipped = await callSharedTool(context, "exec", {
        id: f.row.id,
        command: "printf '%70000s' x",
        cwd: f.root,
      });
      expect(clipped).toMatchObject({ truncated: true });
      await expect(callSharedTool(context, "steer", { id: f.row.id, text: "late" })).rejects.toMatchObject({
        code: "no_running_turn",
      });
      let finish!: (status: "interrupted") => void;
      f.hold(
        new Promise((resolve) => {
          finish = resolve;
        }),
        () => finish("interrupted"),
      );
      const turn = await agent.prompt({
        sandboxId: "physical",
        harness: "codex",
        conversationId: f.first.conversationId,
        text: "working",
      });
      expect(await callSharedTool(context, "steer", { id: f.row.id, text: "redirect" })).toMatchObject({
        promptId: turn.promptId,
        conversationId: turn.conversationId,
        delivery: "restart",
      });
      expect(await callSharedTool(context, "interrupt", { id: f.row.id })).toMatchObject({ interrupted: true });
      expect(await agent.getPrompt({ sandboxId: "physical", promptId: turn.promptId })).toMatchObject({
        status: "interrupted",
        done: true,
      });
      const serving = await createRuntimeServing(f.sql, ENCRYPTION_KEY)(
        { id: placement } as Provider,
        {
          id: f.row.id,
          ...(placement === "boat" ? { boatRuntime: true } : { runtimeTransport: "dialout" as const }),
          provider: placement,
          orgId: f.row.orgId,
          visibility: f.row.visibility ?? "org",
          modal: null,
        },
        { userId: f.people.owner },
      );
      await f.db.query("update credentials set status='revoked' where id=$1", [f.account.id]);
      await expect(serving.steer({ sandboxId: "physical", text: "unauthorized restart" })).rejects.toMatchObject({
        code: "forbidden",
      });
      await expect(agent.exec({ sandboxId: "other", command: "true" })).rejects.toMatchObject({
        code: "invalid_request",
      });
      await expect(
        callSharedTool({ ...context, caller: { ...f.caller, userId: f.people.member } }, "exec", {
          id: f.row.id,
          command: "true",
        }),
      ).rejects.toMatchObject({ code: "forbidden" });
    } finally {
      try {
        await fixture?.close();
      } finally {
        await db.close();
      }
    }
  });
