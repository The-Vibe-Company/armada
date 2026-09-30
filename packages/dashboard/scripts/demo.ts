// Local demo of the live Fleet view, without any key:
//   bun run demo:seed [fleet|empty]          fresh local database with the demo activity
//   bun run demo:report <TICKET> <phase> [message]   a worker report, as `armada report` records it
//   bun scripts/demo.ts ask <TICKET> <question>      a worker question in the coordinator's inbox
//   bun scripts/demo.ts seen <project>               the coordinator read its inbox
// then `ARMADA_DASHBOARD_DEMO=fleet ARMADA_TURSO_URL=file:.demo/armada.db bun run dev`.
import { mkdir, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import {
  addInboxItem,
  openTurso,
  putHandBack,
  recordCoordinatorSeen,
  recordEvent,
  saveRuntimeHandle,
  saveWorkerProfile,
  upsertProject,
} from "@armada/core/read";
import { DEMO_COORDINATOR_SEEN, DEMO_INBOX, DEMO_PROJECTS, demoEvents, projectOfTicket } from "../lib/demo/world";

const DEFAULT_FILE = resolve(import.meta.dir, "../.demo/armada.db");
const url = process.env.ARMADA_TURSO_URL ?? `file:${DEFAULT_FILE}`;
const now = new Date();
const ago = (minutes: number) => new Date(now.getTime() - minutes * 60_000);

const [command, ...args] = process.argv.slice(2);

async function seed(scenario: string) {
  if (!process.env.ARMADA_TURSO_URL) {
    await mkdir(dirname(DEFAULT_FILE), { recursive: true });
    for (const suffix of ["", "-wal", "-shm"]) await rm(`${DEFAULT_FILE}${suffix}`, { force: true });
  }
  const db = await openTurso({ url });
  for (const p of DEMO_PROJECTS) await upsertProject(db, p, ago(60 * 24));
  const s = scenario === "empty" ? "empty" : "fleet";
  for (const e of demoEvents(s)) {
    const base = { project: e.project, ticket: e.ticket };
    await saveRuntimeHandle(db, { ...base, runtime: e.runtime, handle: e.handle, branch: null, at: ago(e.claimed) });
    const codex = e.runtime === "Codex";
    await saveWorkerProfile(db, {
      ...base,
      profile: {
        name: codex ? "codex" : "opus",
        agent: codex ? "codex" : "claude",
        model: codex ? "gpt-6.1-sol" : "opus-5-5-1m",
        effort: "high",
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
    for (const [project, minutes] of Object.entries(DEMO_COORDINATOR_SEEN))
      await recordCoordinatorSeen(db, { project, at: ago(minutes) });
  }
  db.close();
  console.log(`Seeded the ${s} demo in ${url}`);
}

async function withTicket(ticket: string | undefined, work: (project: string, ticket: string) => Promise<void>) {
  const project = ticket ? projectOfTicket(ticket) : null;
  if (!ticket || !project) throw new Error(`unknown demo ticket ${ticket ?? "(none)"}`);
  await work(project.slug, ticket.toUpperCase());
}

async function main() {
  if (command === "seed") return seed(args[0] ?? "fleet");
  const db = await openTurso({ url });
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
    console.log(`Recorded ${command} at ${now.toISOString()} in ${url}`);
  } finally {
    db.close();
  }
}

await main();
