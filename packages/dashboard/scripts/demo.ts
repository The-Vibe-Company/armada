// Local demo of the live Fleet view, without any key, in a local PGlite
// database (.demo/armada), or the Postgres database ARMADA_DEMO_DATABASE_URL
// names: never ARMADA_DATABASE_URL or DATABASE_URL, which may be production's.
//   bun run demo:seed [fleet|busy|large|empty]     fresh local database with the demo activity
//   bun run demo:report <TICKET> <phase> [message]   a worker report, as `armada report` records it
//   bun scripts/demo.ts ask <TICKET> <question>      a worker question in the coordinator's inbox
//   bun scripts/demo.ts seen <project>               the coordinator read its inbox
// then `ARMADA_DASHBOARD_DEMO=fleet ARMADA_DATABASE_URL=pglite:.demo/armada bun run dev`.
// A PGlite database belongs to one process at a time: stop the dashboard before
// `report`, `ask` or `seen` on it, or point both at a Postgres database
// (the dashboard's ARMADA_DATABASE_URL and this script's ARMADA_DEMO_DATABASE_URL).
import { mkdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { deflateSync } from "node:zlib";
import { CONFIG_DEFAULTS, parseConfig } from "@armada/core/read";
import { saveAttachment } from "../lib/attachments";
import { databaseUrlOf, openDatabase } from "../lib/db";
import {
  DEMO_COORDINATOR_SEEN,
  DEMO_INBOX,
  DEMO_PROFILES,
  DEMO_PROJECT_FACTS,
  DEMO_PROJECTS,
  DEMO_VALIDATIONS,
  demoCoordinatorFacts,
  demoEvents,
  demoHistory,
  demoInboxReads,
  demoValidationPr,
  projectOfTicket,
  scenarioOf,
} from "../lib/demo/world";
import {
  addInboxItem,
  addValidation,
  decideValidation,
  putHandBack,
  recordCoordinatorSeen,
  recordEvent,
  releaseRuntimeHandle,
  resolveInboxItem,
  resolveInboxItems,
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
  for (const p of DEMO_PROJECTS)
    await upsertProject(db, { ...p, owner: DEMO_PROJECT_FACTS[p.slug]?.owner ?? null }, ago(60 * 24));
  const s = scenarioOf(scenario);
  for (const e of demoEvents(s)) {
    const base = { project: e.project, ticket: e.ticket };
    await saveRuntimeHandle(db, {
      ...base,
      runtime: e.runtime,
      handle: e.handle,
      branch: `feature/${e.ticket.toLowerCase()}`,
      at: ago(e.claimed),
    });
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
  if (s !== "empty") {
    for (const i of DEMO_INBOX) {
      const item = { project: i.project, ticket: i.ticket, author: i.author, body: i.body, at: ago(i.ago) };
      if (i.kind === "hand-back") await putHandBack(db, item);
      else await addInboxItem(db, { ...item, kind: i.kind, recipient: "coordinator" });
    }
    await seedValidations(db);
    await seedHistory(db);
    // Every inbox read since the coordinator started, oldest first, with what its commands say of it.
    for (const project of Object.keys(DEMO_COORDINATOR_SEEN)) {
      const facts = demoCoordinatorFacts(project) ?? undefined;
      for (const minutes of demoInboxReads(project).reverse())
        await recordCoordinatorSeen(db, { project, facts, at: ago(minutes) });
    }
  }
  await db.end();
  console.log(`Seeded the ${s} demo in ${configured ? "the database ARMADA_DEMO_DATABASE_URL names" : url}`);
}

// ------------------------------------------------------------------ validations (THE-885)

const CRC = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (bytes: Uint8Array) => {
  let c = 0xffffffff;
  for (const b of bytes) c = (CRC[(c ^ b) & 0xff] as number) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
function chunk(type: string, data: Uint8Array): Buffer {
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const out = Buffer.alloc(body.length + 8);
  out.writeUInt32BE(data.length, 0);
  body.copy(out, 4);
  out.writeUInt32BE(crc32(body), body.length + 4);
  return out;
}

/** A synthetic screenshot: a dark page with a header, a hero block in `hue` and a grid of cards. */
function mockScreenshot(hue: [number, number, number], variant: number): Uint8Array {
  const w = 640;
  const h = 400;
  const rows: Buffer[] = [];
  for (let y = 0; y < h; y++) {
    const row = Buffer.alloc(1 + w * 3);
    for (let x = 0; x < w; x++) {
      let c: [number, number, number] = [16, 16, 19];
      if (y < 36) c = [24, 24, 27];
      if (y >= 12 && y < 24 && x >= 20 && x < 120) c = [90, 90, 96];
      const heroBottom = variant === 1 ? 210 : 170;
      const inset = variant === 1 ? 0 : 24;
      if (y >= 56 && y < heroBottom && x >= inset && x < w - inset) c = hue;
      const top = heroBottom + 20;
      if (y >= top && y < top + 140) {
        const col = Math.floor((x - 24) / 202);
        const inCard = x >= 24 && col < 3 && (x - 24) % 202 < 186;
        if (inCard) c = y < top + 80 ? [hue[0] / 2, hue[1] / 2, hue[2] / 2] : [34, 34, 38];
        if (inCard && y >= top + 96 && y < top + 104 && (x - 24) % 202 < 120) c = [150, 150, 156];
      }
      row.set(c, 1 + x * 3);
    }
    rows.push(row);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(w, 0);
  header.writeUInt32BE(h, 4);
  header.set([8, 2, 0, 0, 0], 8);
  return new Uint8Array(
    Buffer.concat([
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      chunk("IHDR", header),
      chunk("IDAT", deflateSync(Buffer.concat(rows))),
      chunk("IEND", new Uint8Array()),
    ]),
  );
}

const HUES: [number, number, number][] = [
  [126, 166, 255],
  [255, 138, 76],
  [182, 241, 90],
];

async function seedValidations(db: Awaited<ReturnType<typeof openDatabase>>) {
  const policy = parseConfig(
    `[project]\nname = "Demo"\nslug = "demo"\n[tracker]\nprogram_root = "DEMO-1"\n[github]\nrepository = "acme/demo"\n`,
  ).policy;
  for (const v of DEMO_VALIDATIONS) {
    const attachments: string[] = [];
    for (const [k, caption] of v.shots.entries()) {
      const saved = await saveAttachment(db, {
        project: v.project,
        ticket: v.ticket,
        input: {
          kind: "image",
          bytes: mockScreenshot(HUES[k % HUES.length] ?? [126, 166, 255], k),
          contentType: "image/png",
        },
        caption,
        reference: "validation",
        author: v.author,
        now: ago(v.ago + 1),
        policy: { ...policy, attachmentsPerTicket: CONFIG_DEFAULTS.attachmentsPerTicket },
      });
      attachments.push(saved.id);
    }
    const added = await addValidation(db, {
      project: v.project,
      ticket: v.ticket,
      kind: v.kind,
      what: v.what,
      reason: v.reason,
      choices: v.choices,
      pr: demoValidationPr(v),
      attachments: v.kind === "merge" ? [] : attachments,
      author: v.author,
      at: ago(v.ago),
    });
    if (v.decided)
      await decideValidation(db, {
        project: v.project,
        id: added.id,
        decision: { outcome: v.decided.outcome, answer: null, note: v.decided.note, by: v.decided.by },
        body: `${v.decided.by} ${v.decided.outcome} validation #${added.id}`,
        at: ago(v.decided.ago),
      });
  }
}

// ------------------------------------------------------------------ two weeks of history (THE-893)

/** The tickets shipped over the last two weeks, as their workers and coordinator recorded them: what /insights reads. */
async function seedHistory(db: Awaited<ReturnType<typeof openDatabase>>) {
  const history = demoHistory();
  for (const [k, h] of history.entries()) {
    const base = { project: h.project, ticket: h.ticket };
    const at = (m: number) => ago(h.claimed - m);
    await saveRuntimeHandle(db, { ...base, runtime: h.runtime, handle: h.handle, branch: null, at: at(0) });
    await saveWorkerProfile(db, {
      ...base,
      profile: {
        name: h.profile,
        ...DEMO_PROFILES[h.profile],
        fastMode: false,
        routed: null,
        reason: null,
        why: "conductor.default_profile",
      },
      at: at(0),
    });
    await recordEvent(db, {
      ...base,
      kind: "claim",
      phase: "planning",
      runtime: h.runtime,
      handle: h.handle,
      at: at(0),
    });
    // A heartbeat every 5 minutes until the merge, but while the worker was quiet: one insert.
    const end = h.steps.at(-1)?.at ?? 0;
    const beats: Date[] = [];
    for (let m = 5; m < end; m += 5) if (!h.quiet || m < h.quiet[0] || m > h.quiet[1]) beats.push(at(m));
    await db.query(
      `INSERT INTO events (project, ticket, kind, runtime, handle, created_at)
       SELECT $1, $2, 'heartbeat', $3, $4, t FROM unnest($5::timestamptz[]) AS t`,
      [h.project, h.ticket, h.runtime, h.handle, beats],
    );
    for (const s of h.steps) {
      if (s.kind === "report")
        await recordEvent(db, { ...base, kind: "report", phase: s.phase, headSha: s.headSha ?? null, at: at(s.at) });
      else if (s.kind === "merge") {
        await recordEvent(db, { ...base, kind: "merge", phase: "merged", headSha: s.headSha, at: at(s.at) });
        await releaseRuntimeHandle(db, h.project, h.ticket, at(s.at));
      } else if (s.kind === "hand-back") {
        await putHandBack(db, {
          ...base,
          author: null,
          body: `Agent status: ready-to-merge — ${h.ticket}`,
          at: at(s.at),
        });
        await resolveInboxItems(db, { ...base, kind: "hand-back", resolution: "merged", at: at(s.until) });
      } else if (s.kind === "validation") {
        const v = await addValidation(db, {
          ...base,
          kind: "merge",
          what: `Merge ${h.ticket}`,
          reason: "the owner approves merges of this project",
          choices: null,
          pr: {
            number: 400 + k,
            url: `https://github.com/acme/${h.project}/pull/${400 + k}`,
            title: `Merge ${h.ticket}`,
            headSha: s.headSha,
            files: null,
            additions: null,
            deletions: null,
            ci: "success",
            preview: null,
          },
          attachments: [],
          author: "coordinator",
          at: at(s.at),
        });
        await decideValidation(db, {
          project: h.project,
          id: v.id,
          decision: {
            outcome: "approved",
            answer: null,
            note: null,
            by: DEMO_PROJECT_FACTS[h.project]?.owner ?? "Owner",
          },
          body: `approved validation #${v.id}`,
          at: at(s.until),
        });
      } else {
        const id = await addInboxItem(db, {
          ...base,
          kind: s.kind,
          recipient: "coordinator",
          author: h.handle,
          body: s.kind === "plan" ? `Plan for ${h.ticket}` : "Which way should this go?",
          at: at(s.at),
        });
        await resolveInboxItem(db, { project: h.project, id, resolution: "answered", at: at(s.until) });
      }
    }
  }
  console.log(`Seeded ${history.length} tickets shipped over the last two weeks`);
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
