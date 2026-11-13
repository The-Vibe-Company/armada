import { expect, test } from "bun:test";
import type { OttoPage, OttoResource } from "@armada/core";
import { encryptSecret } from "@armada/core/server";
import { scopeKey } from "@armada/provider-modal";
import { SQL } from "bun";
import { createOttoApi } from "../src/otto/api.ts";
import { sqlOver } from "../src/sql.ts";

const url = process.env.ARMADA_TEST_POSTGRES_URL;
// Real PostgreSQL catches journal work growing with historical fleet size; PGlite cannot prove its cost.
test.skipIf(!url)(
  "Otto reads one bounded snapshot despite 20,000 stopped journals and reports a capped live fleet honestly",
  async () => {
    const db = new SQL(url ?? "", { max: 1 });
    const org = crypto.randomUUID(),
      owner = crypto.randomUUID(),
      golden = crypto.randomUUID(),
      boatGolden = crypto.randomUUID();
    const key = Buffer.alloc(32, 7).toString("base64");
    const scope = scopeKey({
      orgId: org,
      userId: owner,
      visibility: "org",
      binding: { workspace: "w", environment: "e", appId: "a" },
    });
    const now = new Date();
    const event = {
      id: "e",
      kind: "prompt",
      promptId: "p",
      text: "codex/1366-work",
      status: "running",
      at: now.getTime(),
    };
    try {
      await db.unsafe("insert into auth.users(id) values($1)", [owner]);
      await db.unsafe("insert into orgs(id,name) values($1,$2)", [org, `otto-large-${org}`]);
      await db.unsafe(
        "insert into goldens(id,org_id,owner_id,name,visibility,config,provider,modal_workspace,modal_environment,modal_app_id) values($1,$2,$3,'modal','org','{}','modal','w','e','a')",
        [golden, org, owner],
      );
      await db.unsafe(
        "insert into goldens(id,org_id,owner_id,name,visibility,config) values($1,$2,$3,'boat','org','{}')",
        [boatGolden, org, owner],
      );
      const seeded = performance.now();
      await db.unsafe(
        `insert into sandboxes(id,org_id,golden_id,owner_id,provider,provider_sandbox_id,harness,status,last_observed_at,stopped_at)
      select gen_random_uuid(),$1,$2,$3,'modal',gen_random_uuid()::text,'codex',case when n<=20000 then 'stopped' else 'ready' end::sandbox_status,$4,case when n<=20000 then $4::timestamptz else null end from generate_series(1,20003) n`,
        [org, golden, owner, now],
      );
      await db.unsafe(
        "insert into modal_machines(scope,org_id,owner_id,visibility,id,request_key,record) select $1,org_id,owner_id,'org',provider_sandbox_id,provider_sandbox_id,'{}' from sandboxes where org_id=$2",
        [scope, org],
      );
      await db.unsafe(
        "insert into modal_events(scope,sandbox_id,generation,producer_sequence,event) select $1,provider_sandbox_id,'g',1,$3::text::jsonb from sandboxes where org_id=$2",
        [scope, org, JSON.stringify(event)],
      );
      await db.unsafe(
        `insert into sandboxes(id,org_id,golden_id,owner_id,boat_id,harness,status,last_observed_at) select gen_random_uuid(),$1,$2,$3,gen_random_uuid()::text,'codex','ready',$4 from generate_series(1,2)`,
        [org, boatGolden, owner, now],
      );
      await db.unsafe(
        "insert into runtime_events(sandbox_id,sequence,epoch,event_enc) select id,1,1,$2 from sandboxes where org_id=$1 and provider='boat'",
        [org, await encryptSecret(JSON.stringify(event), key)],
      );
      console.info(`Otto 20k fixture seeded_ms=${Math.round(performance.now() - seeded)}`);
      await db.unsafe("set statement_timeout='1500ms'");
      let queries = 0;
      const base = sqlOver(db);
      const api = createOttoApi(
        {
          query: (q, p) => {
            queries++;
            return base.query(q, p);
          },
        },
        { orgId: org, repository: "example/web" },
        async () => ({ ok: true, caller: { userId: owner, orgs: [{ orgId: org, role: "admin" }], via: "service" } }),
        () => now,
        key,
      );
      for (const view of ["summary", "tasks", "resources", "orphans", "facts"]) {
        queries = 0;
        const start = performance.now();
        const response = await api(new Request(`https://armada.example/api/v1/otto/${view}?org_id=${org}`));
        const elapsed = performance.now() - start;
        console.info(`Otto 20k view=${view} elapsed_ms=${Math.round(elapsed)} queries=${queries}`);
        expect(response?.status).toBe(200);
        const page = (await response?.json()) as OttoPage<OttoResource>;
        expect(page.completeness).toBe("unknown");
        expect(queries).toBe(1);
        expect(elapsed).toBeLessThan(2000);
        if (view === "resources") {
          expect(page.items).toHaveLength(5);
          expect(page.items.map((r: OttoResource) => r.activity?.state)).toEqual(Array(5).fill("live"));
        }
      }
      // More live sandboxes than the hard cap must not assert that absent owners are orphans.
      await db.unsafe(
        `insert into sandboxes(id,org_id,golden_id,owner_id,boat_id,harness,status) select gen_random_uuid(),$1,$2,$3,gen_random_uuid()::text,'codex','ready' from generate_series(1,150)`,
        [org, boatGolden, owner],
      );
      const capped = await api(new Request(`https://armada.example/api/v1/otto/resources?org_id=${org}&limit=100`));
      expect(capped?.status).toBe(200);
      const page = (await capped?.json()) as OttoPage<OttoResource> & {
        fleetCompleteness: string;
        orphanCompleteness: string;
      };
      expect(["partial", "unknown"]).toContain(page.fleetCompleteness);
      expect(page.items.length).toBeLessThanOrEqual(100);
      expect(page.orphanCompleteness).toBe("unknown");
    } finally {
      await db.unsafe("set statement_timeout=0");
      await db.unsafe("delete from modal_events where scope=$1", [scope]);
      await db.unsafe("delete from modal_machines where scope=$1", [scope]);
      await db.unsafe("delete from runtime_events where sandbox_id in (select id from sandboxes where org_id=$1)", [
        org,
      ]);
      await db.unsafe("delete from sandboxes where org_id=$1", [org]);
      await db.unsafe("delete from goldens where org_id=$1", [org]);
      await db.unsafe("delete from orgs where id=$1", [org]);
      await db.unsafe("delete from auth.users where id=$1", [owner]);
      await db.close();
    }
  },
  15000,
);
