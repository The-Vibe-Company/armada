import { afterAll, beforeAll, expect, test } from "bun:test";
import { ownerItems, requestDecision, serveFleet } from "@armada/core/read";
import type { Database } from "../lib/db";
import { fleetStore, getValidation } from "../lib/fleet-store";
import { answerSecretRequest, requestSecret } from "../lib/secret-requests";
import { listEvents, readWorkerSecrets, setSecret, vaultModeOf } from "../lib/vault";
import { tempDatabase } from "./support";

const project = { slug: "widgets", name: "Widgets", repository: "acme/widgets", programRoot: "WID-1" };
const at = new Date("2026-10-01T12:00:00Z");
const mode = vaultModeOf({ ARMADA_SECRETS_KEY: Buffer.alloc(32, 7).toString("hex") });
if (mode.kind !== "on") throw new Error("synthetic vault unavailable");
const vault = mode.key;
const actor = { kind: "person" as const, id: "owner-1", label: "Synthetic Owner" };
const value = "synthetic-provider-secret-value-001";
const input = {
  project: project.slug,
  ticket: "WID-2",
  name: "OPENAI_API_KEY",
  reason: "Evals call the API",
  author: "Coordinator",
  at,
};
let db: Database;
beforeAll(async () => {
  db = await tempDatabase();
  await db.query(
    `INSERT INTO organization (id, name, slug, "createdAt") VALUES ('org-1', 'Widgets', 'widgets', $1), ('org-2', 'Other', 'other', $1)`,
    [at],
  );
  await db.query(
    `INSERT INTO projects (slug, name, repository, program_root, organization_id, created_at, updated_at) VALUES ($1,$2,$3,$4,'org-1',$5,$5)`,
    [project.slug, project.name, project.repository, project.programRoot, at],
  );
});
afterAll(async () => {
  await db?.end();
});

test("a repeated request reuses the link; only a manager can atomically seal, audit, decide and notify without returning the value", async () => {
  const concurrent = await Promise.all([requestSecret(db, input), requestSecret(db, { ...input, ticket: "WID-3" })]);
  const first = concurrent[0];
  expect(concurrent[1]).toEqual(first);
  expect(first.state).toBe("requested");
  if (first.state !== "requested") throw new Error("request missing");
  const duplicate = await requestSecret(db, { ...input, ticket: "WID-3" });
  expect(duplicate).toEqual(first);
  await expect(
    requestDecision(fleetStore(db), {
      project: project.slug,
      id: first.validation.id,
      action: "approve",
      choice: null,
      note: null,
      author: actor.label,
      now: at,
    }),
  ).rejects.toThrow("password field");
  const alerts = ownerItems({
    projects: [],
    waiting: [],
    validations: [{ ...first.validation, title: null, url: null, gallery: [] }],
  });
  expect(alerts).toContainEqual(
    expect.objectContaining({ title: "OPENAI_API_KEY · widgets", href: `/approve/${first.validation.id}` }),
  );
  const save = {
    organization: "org-1",
    role: "owner",
    project: project.slug,
    id: first.validation.id,
    value,
    actor,
    now: at,
  };
  expect(await answerSecretRequest(db, vault, { ...save, role: "member" })).toMatchObject({ ok: false });
  expect(await answerSecretRequest(db, vault, { ...save, organization: "org-2" })).toMatchObject({ ok: false });
  expect((await getValidation(db, project.slug, first.validation.id))?.decision).toBeNull();
  const response = await answerSecretRequest(db, vault, save);
  expect(response).toMatchObject({ ok: true });
  expect(JSON.stringify(response)).not.toContain(value);
  const saved = await getValidation(db, project.slug, first.validation.id);
  expect(saved?.decision).toMatchObject({ outcome: "answered", answer: "set", by: actor.label });
  expect(JSON.stringify(saved)).not.toContain(value);
  const row = (await db.query(`SELECT sealed FROM armada_secret WHERE name = 'OPENAI_API_KEY'`)).rows[0];
  expect(String(row?.sealed)).not.toContain(value);
  const opened = await readWorkerSecrets(db, vault, {
    organization: "org-1",
    project: project.slug,
    names: [input.name],
  });
  expect(opened.values.OPENAI_API_KEY).toBe(value);
  const audit = await listEvents(db, "org-1");
  expect(audit).toContainEqual(expect.objectContaining({ action: "set", actor, keys: [input.name] }));
  expect(JSON.stringify(audit)).not.toContain(value);
  const inbox = (await db.query(`SELECT body FROM inbox_items WHERE request_validation = $1`, [first.validation.id]))
    .rows;
  expect(inbox).toEqual([{ body: "OPENAI_API_KEY is set for widgets" }]);
  expect(JSON.stringify(inbox)).not.toContain(value);
  expect(await answerSecretRequest(db, vault, { ...save, value: "replacement-must-not-be-stored" })).toMatchObject({
    ok: false,
  });
  expect(await requestSecret(db, input)).toEqual({ state: "already-set" });
});

test("an organization secret counts as already set and workers cannot request or bypass the dedicated operation", async () => {
  await setSecret(db, vault, { organization: "org-1", user: null, name: "SERVICE_API_KEY", value, actor, now: at });
  const result = await serveFleet(
    fleetStore(db),
    {
      op: "secrets/request",
      project,
      caller: { kind: "organization" },
      input: { ticket: "WID-4", name: "SERVICE_API_KEY", reason: "Calls the service" },
    },
    { now: () => at, appUrl: "https://example.test" },
  );
  expect(result.body).toMatchObject({ result: { state: "already-set" } });
  expect(JSON.stringify(result.body)).not.toContain(value);
  const worker = await serveFleet(
    fleetStore(db),
    {
      op: "secrets/request",
      project,
      caller: { kind: "worker", ticket: "WID-4" },
      input: { ticket: "WID-4", name: "OTHER_API_KEY", reason: "Calls the service" },
    },
    { now: () => at },
  );
  expect(worker.status).toBe(403);
  const bypass = await serveFleet(
    fleetStore(db),
    {
      op: "validate",
      project,
      caller: { kind: "organization" },
      input: { kind: "secret", ticket: "WID-4", what: "Set a key", secretName: "OTHER_API_KEY" },
    },
    { now: () => at },
  );
  expect(bypass.status).toBe(400);
});

test("a failed completion rolls back the value, audit and decision", async () => {
  const request = await requestSecret(db, { ...input, name: "ROLLBACK_API_KEY" });
  if (request.state !== "requested") throw new Error("request missing");
  await db.query(
    `CREATE FUNCTION reject_secret_notice() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.body = 'ROLLBACK_API_KEY is set for widgets' THEN RAISE EXCEPTION 'synthetic inbox failure'; END IF; RETURN NEW; END $$`,
  );
  await db.query(
    `CREATE TRIGGER reject_secret_notice BEFORE INSERT ON inbox_items FOR EACH ROW EXECUTE FUNCTION reject_secret_notice()`,
  );
  await expect(
    answerSecretRequest(db, vault, {
      organization: "org-1",
      role: "admin",
      project: project.slug,
      id: request.validation.id,
      value,
      actor,
      now: at,
    }),
  ).rejects.toThrow();
  expect((await getValidation(db, project.slug, request.validation.id))?.decision).toBeNull();
  expect((await db.query(`SELECT name FROM armada_secret WHERE name = 'ROLLBACK_API_KEY'`)).rows).toEqual([]);
  expect((await listEvents(db, "org-1")).some((event) => event.keys.includes("ROLLBACK_API_KEY"))).toBe(false);
});
