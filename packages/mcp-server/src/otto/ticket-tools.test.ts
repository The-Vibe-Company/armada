import { afterAll, beforeAll, expect, test } from "bun:test";
import type { Sql } from "@armada/core/server";
import type { PGlite } from "@electric-sql/pglite";
import { openMigratedDatabase } from "../../../../scripts/test-support/migrated-database.ts";
import { objectiveStore } from "./objectives.ts";
import { createOttoTicketApi, publishTicketGraph } from "./ticket-tools.ts";
import { ticketStore } from "./tickets.ts";

let db: PGlite;
const org = "11111111-1111-4111-8111-111111111111";
const user = "22222222-2222-4222-8222-222222222222";
const caller = { userId: user, orgs: [{ orgId: org, role: "admin" as const }], via: "supabase" as const };
const sql: Sql = { query: (text, params) => db.query(text, params) };
beforeAll(async () => {
  db = await openMigratedDatabase();
  await db.query("insert into auth.users(id) values ($1)", [user]);
  await db.query("insert into public.orgs(id,name) values ($1,'Tickets')", [org]);
  await db.query("insert into public.members(org_id,user_id,role) values ($1,$2,'admin')", [org, user]);
});
afterAll(async () => {
  await db?.close();
});
const item = (id: string, dependencies: string[] = []) => ({
  id,
  outcome: "Inspect result",
  criteria: [{ use: "Open result", proof: "Result link" }],
  exclusions: ["Launch"],
  dependencies,
});

test("brief tool records one scoped intention and stable graph; conflicts and denied calls cannot publish", async () => {
  const objective = (await objectiveStore(sql, caller, org).create("owner/repository", "Plan work"))!;
  const graph = { briefRevision: 1, tickets: [item("first"), item("second", ["first"])] };
  // Existing #1871 graph has no journal. A mismatched first request must not poison retries.
  await db.query(
    "insert into public.otto_ticket_graphs(objective_id,org_id,owner_id,brief_revision,graph) values($1,$2,$3,1,$4::jsonb)",
    [objective.id, org, user, JSON.stringify(graph)],
  );
  expect(await publishTicketGraph(sql, caller, org, objective.id, { ...graph, tickets: [item("wrong")] })).toBeNull();
  expect(
    (await db.query("select input from public.otto_ticket_publications where objective_id=$1", [objective.id])).rows,
  ).toEqual([]);
  expect((await publishTicketGraph(sql, caller, org, objective.id, graph))?.tickets.map((t) => t.state)).toEqual([
    "ready",
    "blocked",
  ]);
  expect((await publishTicketGraph(sql, caller, org, objective.id, graph))?.graph).toEqual(graph);
  expect(await publishTicketGraph(sql, caller, org, objective.id, { ...graph, tickets: [item("changed")] })).toBeNull();
  const intents = await db.query<{ input: unknown }>(
    "select input from public.otto_ticket_publications where objective_id=$1",
    [objective.id],
  );
  expect(intents.rows).toEqual([{ input: graph }]);
  const other = { ...caller, userId: crypto.randomUUID() };
  expect(await publishTicketGraph(sql, other, org, objective.id, graph)).toBeNull();
  await expect(
    db.query(
      "insert into public.otto_ticket_publications(objective_id,org_id,owner_id,brief_revision,tool,input) values($1,$2,$3,2,'publish_ticket_graph','{}')",
      [objective.id, org, other.userId],
    ),
  ).rejects.toThrow(/foreign key/);
});

test("web readiness follows latest objective/revision-bound admitted criterion proof, never claims or partial evidence", async () => {
  const objective = (await objectiveStore(sql, caller, org).create("owner/repository", "Observe work"))!;
  const graph = { briefRevision: 1, tickets: [item("first"), item("second", ["first"])] };
  await publishTicketGraph(sql, caller, org, objective.id, graph);
  const route = createOttoTicketApi(sql, async () => ({ ok: true, caller }));
  const states = async () => {
    const response = await route(
      new Request(`https://armada.test/api/v1/otto/objectives/${objective.id}/tickets?org_id=${org}`),
    );
    expect(response?.status).toBe(200);
    return ((await response!.json()) as { tickets: { state: string }[] }).tickets.map((t) => t.state);
  };
  const fact = async (revision: number, completeness: string, value: string, date: string) => {
    await db.query(
      `insert into public.otto_facts(org_id,repository,subject,kind,value,source,source_id,completeness,evidence,observed_at)
   values($1,'owner/repository','ticket:first','ticket.criterion.proof',$2,'criterion-proof',$3,$4,$5::jsonb,$6)`,
      [
        org,
        value,
        crypto.randomUUID(),
        completeness,
        JSON.stringify({ objectiveId: objective.id, briefRevision: revision, ticketId: "first", criterionIndex: 0 }),
        date,
      ],
    );
  };
  await fact(2, "complete", "true", "2026-01-01");
  await fact(1, "partial", "true", "2026-01-02");
  expect(await states()).toEqual(["ready", "blocked"]);
  await fact(1, "complete", "true", "2026-01-03");
  expect(await states()).toEqual(["done", "ready"]);
  await fact(1, "complete", "unknown", "2026-01-04");
  expect(await states()).toEqual(["ready", "blocked"]);
  expect((await ticketStore(sql, caller, org, objective.id).read())?.tickets.map((t) => t.id)).toEqual([
    "first",
    "second",
  ]);
});
