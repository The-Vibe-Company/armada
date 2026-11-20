import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { applyMigrations, openDatabase } from "../../../scripts/db/apply.ts";

const db = await openDatabase();
const owner = crypto.randomUUID();
const member = crypto.randomUUID();
const org = crypto.randomUUID();
const otherOrg = crypto.randomUUID();
const account = crypto.randomUUID();
const fallback = crypto.randomUUID();
const sandbox = crypto.randomUUID();

beforeAll(async () => {
  await applyMigrations(db);
  await db.query("insert into auth.users(id) values($1),($2)", [owner, member]);
  await db.query("insert into public.orgs(id,name) values($1,'Destination'),($2,'Other')", [org, otherOrg]);
  await db.query("insert into public.members(org_id,user_id,role) values($1,$2,'admin'),($1,$3,'member')", [
    org,
    owner,
    member,
  ]);
  await db.query(
    `insert into public.credentials(id,scope,owner_id,kind,value_enc,is_default,version,max_agents,model_limits,name)
     values($1,'user',$3,'openai',decode('1234','hex'),true,7,3,'{"model":2}','My Account'),
           ($2,'user',$3,'openai',decode('5678','hex'),false,1,null,'{}','Fallback')`,
    [account, fallback, owner],
  );
  await db.query(
    `insert into public.agent_defaults(user_id,harness,credential_id,credential_ids,model)
     values($1,'codex',$2,array[$2::uuid,$3::uuid],'model')`,
    [owner, account, fallback],
  );
});

beforeEach(() => db.exec("begin"));
afterEach(() => db.exec("rollback"));
afterAll(() => db.close());

function share(actor = owner) {
  return db.query("select public.share_model_account($1,$2,$3) as id", [actor, account, org]);
}

async function bindSandbox(orgId: string) {
  const golden = crypto.randomUUID();
  await db.query(
    "insert into goldens(id,org_id,name,boat_snapshot_id,visibility,owner_id) values($1,$2,'fixture','snapshot','org',$3)",
    [golden, orgId, owner],
  );
  await db.query(
    `insert into sandboxes(id,boat_id,golden_id,org_id,owner_id,harness,status,credential_id,credential_version)
     values($1,'fixture',$2,$3,$4,'codex','ready',$5,7)`,
    [sandbox, golden, orgId, owner, account],
  );
}

test("sharing preserves account identity and removes defaults that no longer apply", async () => {
  await bindSandbox(org);

  expect((await share()).rows).toEqual([{ id: account }]);
  expect(
    (await db.query("select credential_id,credential_version from sandboxes where id=$1", [sandbox])).rows,
  ).toEqual([{ credential_id: account, credential_version: 7 }]);
  const { rows } = await db.query(
    `select id,scope,owner_id,encode(value_enc,'hex') as ciphertext,version,max_agents,model_limits,name,is_default
     from public.credentials where id=$1`,
    [account],
  );
  expect(rows).toEqual([
    {
      id: account,
      scope: "org",
      owner_id: org,
      ciphertext: "1234",
      version: 7,
      max_agents: 3,
      model_limits: { model: 2 },
      name: "My Account",
      is_default: false,
    },
  ]);
  expect((await db.query("select credential_id,credential_ids,model from public.agent_defaults")).rows).toEqual([
    { credential_id: null, credential_ids: [fallback], model: "model" },
  ]);
});

test("sharing requires destination admin membership", async () => {
  await db.query("update public.members set role='admin' where org_id=$1 and user_id=$2", [org, member]);
  await db.query("update public.members set role='member' where org_id=$1 and user_id=$2", [org, owner]);
  await expect(share()).rejects.toMatchObject({ code: "42501" });
});

test("a destination administrator cannot share another user's account", async () => {
  await db.query("update public.members set role='admin' where org_id=$1 and user_id=$2", [org, member]);
  await expect(share(member)).rejects.toMatchObject({ code: "P0002" });
});

test("a same-kind destination conflict leaves the original account in place", async () => {
  await db.query(
    "insert into public.credentials(scope,owner_id,kind,value_enc) values('org',$1,'openai',decode('12','hex'))",
    [org],
  );
  await db.exec("savepoint attempt");
  await expect(share()).rejects.toMatchObject({ code: "23505", message: expect.stringContaining("already has") });
  await db.exec("rollback to savepoint attempt");
  expect((await db.query("select scope,is_default from public.credentials where id=$1", [account])).rows).toEqual([
    { scope: "user", is_default: true },
  ]);
});

test("a sandbox in another organization prevents sharing", async () => {
  await bindSandbox(otherOrg);
  await expect(share()).rejects.toMatchObject({ code: "55000" });
});

test("an unpublished capacity reservation prevents sharing", async () => {
  await db.query("insert into public.account_agent_reservations(account_id,sandbox_id) values($1,$2)", [
    account,
    sandbox,
  ]);
  await expect(share()).rejects.toMatchObject({ code: "55000" });
});

test.each(["anon", "authenticated", "service_role"])("the share function is ungranted for %s", async (role) => {
  const { rows } = await db.query(
    "select has_function_privilege($1, 'public.share_model_account(uuid,uuid,uuid)', 'execute') as granted",
    [role],
  );
  expect(rows).toEqual([{ granted: false }]);
});

test("the service role cannot bypass the share transaction by updating the table", async () => {
  await db.exec(`
    set local role service_role;
    set local armada.share_model_account = 'on';
    create temporary table pg_proc(oid oid, proowner oid);
    insert into pg_temp.pg_proc values (
      'public.share_model_account(uuid,uuid,uuid)'::pg_catalog.regprocedure,
      (select oid from pg_catalog.pg_roles where rolname=current_user)
    );
  `);
  await expect(
    db.query("update public.credentials set scope='org', owner_id=$2 where id=$1", [account, org]),
  ).rejects.toMatchObject({ code: "23514" });
});
