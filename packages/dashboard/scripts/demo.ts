// Local demo of the live Fleet view, without any key, in a local PGlite
// database (.demo/armada), or the Postgres database ARMADA_DEMO_DATABASE_URL
// names: never ARMADA_DATABASE_URL or DATABASE_URL, which may be production's.
//   bun run demo:seed [fleet|empty]          fresh local database with the demo activity
//   bun run demo:report <TICKET> <phase> [message]   a worker report, as `armada report` records it
//   bun scripts/demo.ts ask <TICKET> <question>      a worker question in the coordinator's inbox
//   bun scripts/demo.ts seen <project>               the coordinator read its inbox
// then `ARMADA_DASHBOARD_DEMO=fleet ARMADA_DATABASE_URL=pglite:.demo/armada bun run dev`.
// A PGlite database belongs to one process at a time: stop the dashboard before
// `report`, `ask` or `seen` on it, or point both at a Postgres database
// (the dashboard's ARMADA_DATABASE_URL and this script's ARMADA_DEMO_DATABASE_URL).
import { mkdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { databaseUrlOf, openDatabase } from "../lib/db";
import {
  DEMO_COORDINATOR_SEEN,
  DEMO_INBOX,
  DEMO_PROFILES,
  DEMO_PROJECTS,
  demoCoordinatorFacts,
  demoEvents,
  demoInboxReads,
  projectOfTicket,
} from "../lib/demo/world";
import {
  addInboxItem,
  putHandBack,
  recordCoordinatorSeen,
  recordEvent,
  saveRuntimeHandle,
  saveWorkerProfile,
  upsertProject,
} from "../lib/fleet-store";

const DEFAULT_DIR = resolve(import.meta.dir, "../.demo/armada");
const configured = databaseUrlOf({ ARMADA_DATABASE_URL: process.env.ARMADA_DEMO_DATABASE_URL });
const url = configured ?? `pglite:${DEFAULT_DIR}`;
const now = new Date();
const ago = (minutes: number) => new Date(now.getTime() - minutes * 60_000);

const [command, ...args] = process.argv.slice(2);

async function seed(scenario: string) {
  if (!configured) {
    await rm(DEFAULT_DIR, { recursive: true, force: true });
    await mkdir(DEFAULT_DIR, { recursive: true });
  }
  const db = await openDatabase(url);
  for (const p of DEMO_PROJECTS) await upsertProject(db, p, ago(60 * 24));
  const s = scenario === "empty" ? "empty" : "fleet";
  for (const e of demoEvents(s)) {
    const base = { project: e.project, ticket: e.ticket };
    await saveRuntimeHandle(db, { ...base, runtime: e.runtime, handle: e.handle, branch: null, at: ago(e.claimed) });
    await saveWorkerProfile(db, {
      ...base,
      profile: {
        name: e.profile,
        ...DEMO_PROFILES[e.profile],
        fastMode: false,
        routed: null,
        reason: null,
        why: "conductor.default_profile",
      },
      at: ago(e.claimed),
    });
    await recordEvent(db, {
      ...base,
      kind: "claim",
      phase: "planning",
      runtime: e.runtime,
      handle: e.handle,
      at: ago(e.claimed),
    });
    await recordEvent(db, { ...base, kind: "report", phase: e.phase, message: e.summary, at: ago(e.lastReport) });
  }
  if (s === "fleet") {
    for (const i of DEMO_INBOX) {
      const item = { project: i.project, ticket: i.ticket, author: i.author, body: i.body, at: ago(i.ago) };
      if (i.kind === "hand-back") await putHandBack(db, item);
      else await addInboxItem(db, { ...item, kind: i.kind, recipient: "coordinator" });
    }
    // Each coordinator read its inbox every 15 minutes since it started, oldest first.
    for (const project of Object.keys(DEMO_COORDINATOR_SEEN))
      for (const minutes of demoInboxReads(project).reverse())
        await recordCoordinatorSeen(db, { project, facts: demoCoordinatorFacts(project), at: ago(minutes) });
  }
  await db.end();
  console.log(`Seeded the ${s} demo in ${configured ? "the database ARMADA_DEMO_DATABASE_URL names" : url}`);
}

async function withTicket(ticket: string | undefined, work: (project: string, ticket: string) => Promise<void>) {
  const project = ticket ? projectOfTicket(ticket) : null;
  if (!ticket || !project) throw new Error(`unknown demo ticket ${ticket ?? "(none)"}`);
  await work(project.slug, ticket.toUpperCase());
}

async function main() {
  if (command === "seed") return seed(args[0] ?? "fleet");
  const db = await openDatabase(url);
  try {
    if (command === "report")
      await withTicket(args[0], (project, ticket) =>
        recordEvent(db, { project, ticket, kind: "report", phase: args[1] ?? null, message: args[2] ?? null, at: now }),
      );
    else if (command === "ask")
      await withTicket(args[0], async (project, ticket) => {
        await addInboxItem(db, {
          project,
          ticket,
          kind: "question",
          recipient: "coordinator",
          author: "Worker",
          body: args.slice(1).join(" ") || "Which option should I take?",
          at: now,
        });
      });
    else if (command === "seen") await recordCoordinatorSeen(db, { project: args[0] ?? "widgets", at: now });
    else throw new Error(`usage: bun scripts/demo.ts seed|report|ask|seen … (see ${join("scripts", "demo.ts")})`);
    console.log(`Recorded ${command} at ${now.toISOString()}`);
  } finally {
    await db.end();
  }
}

await main();
