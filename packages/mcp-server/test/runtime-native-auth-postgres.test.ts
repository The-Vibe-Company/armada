import { expect, test } from "bun:test";
import { encryptSecret } from "@armada/core/server";
import { SQL } from "bun";
import { createModelAuthOwnership } from "../src/model-auth.ts";
import { createRuntimeEnrolments, RuntimeEnrolmentDenied } from "../src/runtime-enrolment.ts";
import { createRuntimeNativeAuth } from "../src/runtime-native-auth.ts";
import { sqlOver } from "../src/sql.ts";

// CI's already-migrated disposable PostgreSQL only. Never point at production.
const url = process.env.ARMADA_TEST_POSTGRES_URL;
test.skipIf(!url)(
  "PostgreSQL runtime publication cannot hold a sandbox while awaiting credential and rechecks after lifecycle replacement",
  async () => {
    const admin = new SQL(url ?? "", { max: 1 }),
      native = new SQL(url ?? "", { max: 1 }),
      changer = new SQL(url ?? "", { max: 1 });
    const sql = sqlOver({
      unsafe: (q, v) => native.unsafe(q, v),
      begin: (work) => native.begin((tx) => work({ unsafe: (q, v) => tx.unsafe(q, v) })),
    });
    const owner = crypto.randomUUID(),
      org = crypto.randomUUID(),
      golden = crypto.randomUUID(),
      sandbox = crypto.randomUUID(),
      account = crypto.randomUUID();
    const key = Buffer.alloc(32, 4).toString("base64"),
      auth = (n: number) =>
        JSON.stringify({
          tokens: {
            account_id: "offline-pg-account",
            access_token: `offline-access-${n}`,
            refresh_token: `offline-refresh-${n}`,
          },
        });
    const locked = Promise.withResolvers<void>(),
      replace = Promise.withResolvers<void>();
    let changing: Promise<unknown> | undefined, publishing: Promise<unknown> | undefined;
    try {
      await admin.unsafe("insert into auth.users(id) values($1)", [owner]);
      await admin.unsafe("insert into orgs(id,name) values($1,'native-publication-race')", [org]);
      await admin.unsafe("insert into members(org_id,user_id,role) values($1,$2,'member')", [org, owner]);
      await admin.unsafe(
        "insert into credentials(id,scope,owner_id,kind,value_enc) values($1,'user',$2,'codex_auth',$3)",
        [account, owner, await encryptSecret(auth(0), key)],
      );
      await createModelAuthOwnership(sql, key).claimLegacy(
        { userId: owner, orgId: org, role: "member" },
        account,
        1,
        sandbox,
      );
      await admin.unsafe(
        "insert into goldens(id,org_id,owner_id,name,visibility,config) values($1,$2,$3,'native-publication-race','private','{}')",
        [golden, org, owner],
      );
      await admin.unsafe(
        "insert into sandboxes(id,golden_id,org_id,owner_id,boat_id,harness,status,credential_id,credential_version) values($1,$2,$3,$4,$5,'codex','ready',$6,1)",
        [sandbox, golden, org, owner, `race-${sandbox}`, account],
      );
      const authority = createRuntimeEnrolments(sql, key);
      const active = await authority.enrol(
        (await authority.issue({ sandboxId: sandbox, ownerId: owner, configuration: {} })).enrolmentToken,
      );
      const pid = Number((await native.unsafe("select pg_backend_pid() as pid"))[0].pid);
      await native.unsafe("set statement_timeout='5s'");
      await changer.unsafe("set statement_timeout='5s'");
      changing = changer.begin(async (tx) => {
        await tx.unsafe("select id from credentials where id=$1 for update", [account]);
        locked.resolve();
        await replace.promise;
        await tx.unsafe("update sandboxes set lifecycle_generation=lifecycle_generation+1 where id=$1", [sandbox]);
      });
      await locked.promise;
      publishing = createRuntimeNativeAuth(
        sql,
        key,
      )({
        token: active.runtimeToken,
        epoch: active.epoch,
        sandboxId: sandbox,
        generation: active.epoch,
        authJson: auth(1),
        expectedRevision: 0,
      }).then(
        (value) => value,
        (error: unknown) => error,
      );
      let blocked = false;
      for (let attempt = 0; attempt < 1000; attempt++)
        if ((await admin.unsafe("select cardinality(pg_blocking_pids($1))>0 as blocked", [pid]))[0].blocked) {
          blocked = true;
          break;
        }
      expect(blocked).toBe(true);
      replace.resolve();
      await changing;
      expect(await publishing).toBeInstanceOf(RuntimeEnrolmentDenied);
      expect(
        Number(
          (await admin.unsafe("select auth_revision from model_auth_state where account_id=$1", [account]))[0]
            .auth_revision,
        ),
      ).toBe(0);
    } finally {
      replace.resolve();
      await Promise.allSettled([changing, publishing]);
      await admin.unsafe("delete from model_auth_ownership where account_id=$1", [account]);
      await admin.unsafe("delete from model_auth_state where account_id=$1", [account]);
      await admin.unsafe("delete from sandboxes where id=$1", [sandbox]);
      await admin.unsafe("delete from goldens where id=$1", [golden]);
      await admin.unsafe("delete from credentials where id=$1", [account]);
      await admin.unsafe("delete from members where org_id=$1", [org]);
      await admin.unsafe("delete from mcp_invalidations where org_id=$1", [org]);
      await admin.unsafe("delete from orgs where id=$1", [org]);
      await admin.unsafe("delete from auth.users where id=$1", [owner]);
      await Promise.all([admin.close(), native.close(), changer.close()]);
    }
  },
);
