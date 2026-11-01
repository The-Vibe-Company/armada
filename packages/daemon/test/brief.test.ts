import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Ticket } from "@armada/protocol";
import { BUNDLED_SKILLS } from "../../core/src/skills.ts";
import { fold } from "../src/fold.ts";
import { workerBrief } from "../src/workers/brief.ts";
import { loadBriefContext } from "../src/workers/brief-context.ts";

const ticket: Ticket = {
  id: "SEED-2",
  title: "Plant the orchard",
  description: "Keep the saplings watered.",
  status: "unstarted",
  parent: "SEED-1",
  blockers: [],
};
const protocol = BUNDLED_SKILLS.find((s) => s.name === "armada-worker")!.files.find(
  (f) => f.path === "SKILL.md",
)!.content;
function input() {
  return {
    ticket,
    tables: {
      ...fold([
        {
          seq: 1,
          project: "orchard",
          at: "2030-01-01T00:00:00Z",
          actor: "tracker",
          kind: "ticket.seen",
          payload: ticket,
        },
      ]).projects.orchard!,
      tickets: [
        ticket,
        {
          id: "SEED-1",
          title: "Orchard specification",
          description: "Grow fruit for the village.",
          status: "started" as const,
        },
      ],
    },
    repository: "example/orchard",
    branch: "worker/seed-2",
    instructions: { name: "AGENTS.md", text: "Use the orchard's tools." },
    extra: { name: "docs/conventions.md", text: "Measure the rows twice." },
    notes: "Start with the northern row.",
    profileInstructions: "Review irrigation carefully.",
  };
}

test("brief carries ordered launch context and the complete bundled worker protocol without npm", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "armada-brief-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const value = input();
  await writeFile(join(root, "AGENTS.md"), value.instructions.text);
  await writeFile(join(root, "CLAUDE.md"), "Unselected Claude rules");
  await writeFile(join(root, "armada.toml"), '[brief]\nextra = "conventions.md"\n');
  await writeFile(join(root, "conventions.md"), value.extra.text);
  const brief = workerBrief({ ...value, ...(await loadBriefContext(root)) });
  assert(!brief.includes("Unselected Claude rules"));
  const sections = [
    ticket.description!,
    "Orchard specification",
    "Grow fruit for the village.",
    "## Repository instructions",
    "Use the orchard's tools.",
    "## Project conventions",
    "Measure the rows twice.",
    "## Coordinator notes",
    "Start with the northern row.",
    "## Worker protocol",
    protocol,
    "## Profile instructions",
    "Review irrigation carefully.",
  ];
  let previous = -1;
  for (const section of sections) {
    const at = brief.indexOf(section);
    assert(at > previous, `missing or out-of-order section: ${section.slice(0, 80)}`);
    previous = at;
  }
  assert(Buffer.byteLength(brief) < 48 * 1024);
  assert.match(brief, /if it fails, say so in your first report/);
  assert.match(brief, /command -v armada/);
  assert(
    !brief.split("## Launch instructions")[1]!.includes("armada skill armada-worker"),
    "protocol is delivered, not fetched by the worker",
  );
});

test("brief bounds UTF-8 sections, marks cuts and preserves ticket and protocol", () => {
  const value = input();
  value.tables.tickets[1]!.description = "spec🌳".repeat(2000);
  value.instructions.text = "rules🌳".repeat(2000);
  value.extra.text = "conventions🌳".repeat(12000);
  value.notes = "notes🌳".repeat(8000);
  value.profileInstructions = "route🌳".repeat(8000);
  value.ticket = { ...ticket, description: "ticket🌳".repeat(900) };
  const brief = workerBrief(value);
  assert(Buffer.byteLength(brief) < 48 * 1024);
  assert(brief.includes(value.ticket.description!));
  assert(brief.includes(protocol));
  assert(!brief.includes("�"));
  for (const heading of [
    "Parent",
    "Repository instructions",
    "Project conventions",
    "Coordinator notes",
    "Profile instructions",
  ]) {
    const section = brief.split(`## ${heading}`)[1]!.split("\n\n## ")[0]!;
    assert.match(section, /\[truncated/);
  }
  const parent = brief.split("## Parent\n\n")[1]!.split("\n\n## ")[0]!;
  const rules = brief.split("## Repository instructions")[1]!.split("\n\n## ")[0]!;
  assert(Buffer.byteLength(parent.split("\n\n")[1]!) <= 4096);
  assert(Buffer.byteLength(rules.split("\n\n")[1]!) <= 8192);
});

test("brief refuses an oversized protected ticket instead of silently cutting it", () => {
  const value = input();
  value.ticket = { ...ticket, description: "must keep🌳".repeat(6000) };
  assert.throws(() => workerBrief(value), /ticket and worker protocol.*48 KiB/i);
});

test("repository instructions fall back to CLAUDE.md and can be absent", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "armada-brief-missing-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "CLAUDE.md"), "Use the seed catalogue.");
  const fallback = workerBrief({
    ...input(),
    instructions: undefined,
    extra: undefined,
    ...(await loadBriefContext(root)),
  });
  assert.match(fallback, /Repository instructions \(CLAUDE.md\)/);
  assert(fallback.includes("Use the seed catalogue."));
  await rm(join(root, "CLAUDE.md"));
  const missing = workerBrief({
    ...input(),
    instructions: undefined,
    extra: undefined,
    ...(await loadBriefContext(root)),
  });
  assert(!missing.includes("## Repository instructions"));
  assert(missing.includes(ticket.description!));
  assert(missing.includes(protocol));
});

test("an explicit extra file must exist inside the registered root", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "armada-brief-path-"));
  const root = join(directory, "root");
  const { mkdir } = await import("node:fs/promises");
  await mkdir(root);
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(root, "inside.md"), "Project-only conventions");
  await writeFile(join(directory, "outside.md"), "Unrelated file");
  await writeFile(join(root, "armada.toml"), '[brief]\nextra = "inside.md"\n');
  assert.equal((await loadBriefContext(root)).extra?.text, "Project-only conventions");
  await symlink(join(directory, "outside.md"), join(root, "linked.md"));
  for (const path of ["../outside.md", "linked.md", "missing.md"]) {
    await writeFile(join(root, "armada.toml"), `[brief]\nextra = "${path}"\n`);
    await assert.rejects(loadBriefContext(root));
  }
});

test("context reads bounded UTF-8 prefixes and marks oversized repository files", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "armada-brief-prefix-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "AGENTS.md"), "🌳rules".repeat(20000));
  await writeFile(join(root, "conventions.md"), "🌳conventions".repeat(20000));
  await writeFile(join(root, "armada.toml"), '[brief]\nextra = "conventions.md"\n');
  const context = await loadBriefContext(root);
  assert(context.instructions);
  assert(context.extra);
  assert(Buffer.byteLength(context.instructions.text) <= 8192 + 128);
  assert(Buffer.byteLength(context.extra.text) <= 48 * 1024 + 128);
  for (const file of [context.instructions, context.extra]) {
    assert.match(file.text, /\[truncated/);
    assert(!file.text.includes("�"));
  }
  await writeFile(join(root, "armada.toml"), "#".repeat(300000));
  await assert.rejects(loadBriefContext(root), /too large/);
});

test("special repository files refuse without blocking the daemon", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "armada-brief-special-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "AGENTS.md"), "Regular repository instructions");
  assert.equal((await loadBriefContext(root)).instructions?.text, "Regular repository instructions");
  await rm(join(root, "AGENTS.md"));
  execFileSync("mkfifo", [join(root, "AGENTS.md")]);
  // A child deadline also keeps this regression from leaving a blocked filesystem read in the test runner.
  execFileSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
    import assert from "node:assert/strict";
    import { loadBriefContext } from ${JSON.stringify(new URL("../src/workers/brief-context.ts", import.meta.url).href)};
    await assert.rejects(loadBriefContext(process.argv[1]), /regular file/);
  `,
      root,
    ],
    { timeout: 2000, stdio: "pipe" },
  );
});
