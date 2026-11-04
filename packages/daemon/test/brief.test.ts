import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Ticket } from "@armada/protocol";
import { BUNDLED_SKILLS } from "../../core/src/skills.ts";
import { fold } from "../src/fold.ts";
import { TURN_RULE, workerBrief } from "../src/workers/brief.ts";
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
  // The local launch runs on the owner's desktop (THE-2234): the brief names what a worker never does there.
  const launch = brief.split("## Launch instructions")[1]!.split("\n\n## ")[0]!;
  assert.match(launch, /Never open a window or an app \(`open -a`/);
  assert.match(launch, /`osascript`/);
  assert.match(launch, /`screencapture`/);
  assert.match(launch, /ARMADA_DESKTOP_HEADLESS=1/);
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

test("brief inlines only the newest six comments, each at most 600 characters, and points to the ticket", () => {
  const comments = Array.from({ length: 12 }, (_, i) => ({
    author: `Gardener ${i}`,
    at: `2030-01-${String(i + 1).padStart(2, "0")}T00:00:00Z`,
    body: `Comment ${i}: ${"🌳".repeat(700)} END-${i}`,
  }));
  const value = input();
  // Interleaved input catches accidental reliance on provider ordering or slice direction.
  value.ticket = { ...ticket, comments: comments.filter((_, i) => i % 2).concat(comments.filter((_, i) => !(i % 2))) };
  const brief = workerBrief(value);
  const excerpts = [...brief.matchAll(/## Recorded by (.+) at ([^\n]+)\n\n([\s\S]*?)(?=\n\n## |$)/g)];
  assert.equal(excerpts.length, 6);
  assert.deepEqual(
    excerpts.map((m) => m[1]),
    [11, 10, 9, 8, 7, 6].map((i) => `Gardener ${i}`),
  );
  for (const [index, excerpt] of excerpts.entries()) {
    const body = excerpt[3]!;
    assert.equal(Array.from(body).length, 600);
    assert.ok(body.startsWith(`Comment ${11 - index}: `));
    assert.match(body, /\[truncated\]$/);
    assert.ok(!body.includes("�"));
  }
  assert.match(brief, /## More context\n\nRun `armada ticket` for the full ticket and its comments\./);
  const url = "https://linear.app/example/issue/SEED-2";
  assert.ok(!brief.includes(url));
  const linked = workerBrief({ ...value, ticket: { ...value.ticket, url } });
  assert.ok(linked.includes(url), "the Linear link stays available to humans");
  const hosted = workerBrief({
    ...value,
    ticket: { ...value.ticket, url },
    hosted: {
      token: "synthetic-launch-token",
      apiUrl: "https://armada.example.invalid",
      profile: "claude",
      project: "orchard",
    },
  });
  const hostedContext = hosted.split("## More context\n\n")[1]?.split("\n\n## ")[0] ?? "";
  assert.ok(hostedContext.includes(url), "hosted workers retain their ticket link");
  assert.ok(!hostedContext.includes("armada ticket"), "hosted workers have no local socket capability");
  const hostedLaunch = hosted.split("## Launch instructions")[1]!.split("\n\n## ")[0]!;
  assert.ok(!hostedLaunch.includes("ARMADA_DESKTOP_HEADLESS"), "only a local launch names the desktop flag it sets");
  assert.ok(Buffer.byteLength(linked) < 48 * 1024);
  assert.match(workerBrief(input()), /Run `armada ticket` for the full ticket and its comments/);
  assert.deepEqual(
    value.ticket.comments,
    comments.filter((_, i) => i % 2).concat(comments.filter((_, i) => !(i % 2))),
    "rendering must not reorder the ticket's comments",
  );
  const short = workerBrief({
    ...value,
    ticket: { ...ticket, comments: [{ ...comments[0]!, body: "The soil is ready." }] },
  });
  assert.match(short, /\n\nThe soil is ready\.\n\n/);
  const invalid = workerBrief({
    ...value,
    ticket: {
      ...value.ticket,
      comments: [{ author: "Unknown date", at: "unknown", body: "Undated comment" }, ...comments],
    },
  });
  assert.deepEqual(
    [...invalid.matchAll(/## Recorded by (.+) at /g)].map((m) => m[1]),
    [11, 10, 9, 8, 7, 6].map((i) => `Gardener ${i}`),
    "an undated comment must not displace any of the newest six dated comments",
  );
});

test("the worker skill and assembled brief share one six-word vocabulary mapped to existing phases", () => {
  const brief = workerBrief(input());
  const words = ["progress", "waiting", "ready", "blocked", "failed", "dropped"];
  for (const text of [protocol, brief]) {
    const vocabularies = [...text.matchAll(/## Report vocabulary\n([\s\S]*?)(?=\n## |$)/g)];
    assert.equal(vocabularies.length, 1);
    const vocabulary = vocabularies[0]![1]!;
    assert.deepEqual(
      [...vocabulary.matchAll(/^- `([a-z]+)`:/gm)].map((m) => m[1]),
      words,
    );
    for (const phase of [
      "implementing",
      "shipping",
      "awaiting-approval",
      "awaiting-validation",
      "ready-to-merge",
      "blocked",
    ]) {
      assert.ok(vocabulary.includes(`\`${phase}\``), `map vocabulary to ${phase}`);
    }
    assert.match(vocabulary, /An unfinished draft is blocked, even with green tests/);
    assert.match(vocabulary, /stay in `implementing` or `shipping`; do not enter `blocked`/);
    assert.match(vocabulary, /`ready`: reviewed, checks green on the pushed head, review threads resolved/);
    for (const word of ["failed", "dropped"]) {
      const definition = vocabulary.match(new RegExp(`^- \`${word}\`: (.+)$`, "m"))?.[1] ?? "";
      assert.ok(definition.includes(`Use \`blocked\` with \`${word}:\``), `map ${word} to blocked`);
    }
    assert.match(vocabulary, /full SHA/);
    assert.match(vocabulary, /Keep the evidence in the report; the coordinator forwards only the question/);
    assert.match(vocabulary, /Keep working on what the answer does not change/);
    assert.equal(text.split("Report a milestone once.").length - 1, 1);
    assert.equal(text.split("There is no budget of attempts.").length - 1, 1);
    assert.match(text, /name the interface and who it affects/);
    const messages = [...text.matchAll(/--message "([^"]+)"/g)].map((m) => m[1] ?? "");
    assert.ok(messages.length);
    for (const message of messages)
      assert.match(message, /^(?:progress|waiting|ready|blocked|failed|dropped|<word>): /);
  }
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

test("a local brief opens with the turn rule; a hosted one does not", () => {
  const head = (brief: string) => brief.split("\n\n## Ticket")[0]!;
  const local = head(workerBrief(input()));
  assert.ok(local.includes(TURN_RULE), "the rule sits under the title, before the ticket");
  assert.match(TURN_RULE, /never end a turn to wait for a background task or subagent, because/);
  const hosted = head(
    workerBrief({
      ...input(),
      hosted: {
        token: "synthetic-launch-token",
        apiUrl: "https://armada.example.invalid",
        profile: "claude",
        project: "orchard",
      },
    }),
  );
  assert.ok(hosted.includes("You are an Armada worker"));
  assert.ok(!hosted.includes(TURN_RULE), "a hosted runtime keeps its own sessions alive");
});
