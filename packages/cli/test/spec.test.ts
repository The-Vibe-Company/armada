import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatWorkerSession } from "../../core/src/credentials.ts";
import { DEMO_TOML, FakeLinear, NOW, recordedFetch } from "../../core/test/support.ts";
import { type Io, run } from "../src/cli.ts";

function setup(style = "N") {
  const linear = new FakeLinear();
  linear.add("DEMO-1", { uuid: "uuid-demo-1", teamId: "team-demo" });
  linear.add("DEMO-2", { uuid: "uuid-demo-2", title: "Spec 1/2 — Sign in with email" });
  linear.add("DEMO-3", { uuid: "uuid-demo-3", title: "Spec 2/2 — Share a list" });
  const out: string[] = [];
  const err: string[] = [];
  const io: Io = {
    cwd: "/work/widgets",
    env: { LINEAR_API_KEY: "synthetic-key" },
    readFile: async (path) =>
      path === "/work/widgets/armada.toml"
        ? DEMO_TOML.replace("[tracker]", `[tracker]\nspec_titles = "${style}"`)
        : null,
    stdout: (s) => out.push(s),
    stderr: (s) => err.push(s),
    ghToken: () => null,
    fetch: recordedFetch().fetch,
    now: () => NOW,
    linearWriter: () => linear,
  };
  return { io, linear, out: () => out.join(""), err: () => err.join("") };
}

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

test("spec add appends immediately with a template, root parent and printed URL, without renames", async () => {
  const w = setup();
  expect(await run(["spec", "add", "Search images"], w.io)).toBe(0);
  expect(w.linear.creates).toEqual([
    {
      teamId: "team-demo",
      parentId: "uuid-demo-1",
      title: "Spec 3 — Search images",
      description: expect.stringContaining("## In short"),
    },
  ]);
  expect(w.linear.writes).toHaveLength(1);
  expect(w.out()).toContain("https://linear.app/acme/issue/DEMO-4");
});

test("explicit position previews all renames and creates nothing without --apply", async () => {
  const w = setup();
  expect(await run(["spec", "add", "Search images", "--at", "2"], w.io)).toBe(0);
  expect(w.out()).toContain("Spec 2/2 — Share a list → Spec 3/2 — Share a list");
  expect(w.out()).toContain("Create: Spec 2 — Search images");
  expect(w.out()).toContain("--apply");
  expect(w.linear.writes).toEqual([]);
});

test("spec add --apply updates totals and suffix in sequence before creating under the root", async () => {
  const w = setup("N/M");
  const seen: string[] = [];
  w.io.stdout = (s) => seen.push(s);
  const update = w.linear.updateTicket.bind(w.linear);
  w.linear.updateTicket = async (uuid, change) => {
    expect(seen.join("")).toContain("Spec 1/2 — Sign in with email → Spec 1/3 — Sign in with email");
    expect(w.linear.creates).toHaveLength(0);
    await update(uuid, change);
  };
  expect(await run(["spec", "add", "Search images", "--at", "2", "--apply"], w.io)).toBe(0);
  expect(w.linear.writes.slice(0, 2)).toEqual([
    'update DEMO-3 {"title":"Spec 3/3 — Share a list"}',
    'update DEMO-2 {"title":"Spec 1/3 — Sign in with email"}',
  ]);
  expect(w.linear.creates[0]).toMatchObject({
    teamId: "team-demo",
    parentId: "uuid-demo-1",
    title: "Spec 2/3 — Search images",
  });
  expect(seen.join("")).toContain("https://linear.app/acme/issue/DEMO-4");
});

test("append with totals previews the global total bump, and renumber previews by default", async () => {
  for (const command of [
    ["spec", "add", "Search images"],
    ["spec", "renumber"],
  ]) {
    const w = setup(command[1] === "add" ? "N/M" : "N");
    expect(await run(command, w.io)).toBe(0);
    expect(w.out()).toContain("Renames (2)");
    expect(w.linear.writes).toEqual([]);
  }
  const w = setup();
  expect(await run(["spec", "renumber", "--apply", "--json"], w.io)).toBe(0);
  expect(w.linear.get("DEMO-2").title).toBe("Spec 1 — Sign in with email");
  expect(JSON.parse(w.out())).toMatchObject({ applied: true, create: null, created: null });
});

test("a failed write stops immediately and lists only the unfinished operations", async () => {
  const w = setup("N/M");
  const update = w.linear.updateTicket.bind(w.linear);
  w.linear.updateTicket = async (uuid, change) => {
    if (uuid === "uuid-demo-2") throw new Error("synthetic Linear failure");
    await update(uuid, change);
  };
  expect(await run(["spec", "add", "Search images", "--at", "2", "--apply"], w.io)).toBe(1);
  expect(w.linear.writes).toHaveLength(1);
  expect(w.linear.creates).toHaveLength(0);
  expect(w.err()).toContain("Spec 1/2 — Sign in with email → Spec 1/3 — Sign in with email");
  expect(w.err()).not.toContain("Share a list");
  expect(w.err()).toContain("Create: Spec 2/3 — Search images");
});

test("creation failure lists the pending creation after successful renames", async () => {
  const w = setup();
  w.linear.createIssue = async () => {
    throw new Error("synthetic create failure");
  };
  expect(await run(["spec", "add", "Search images", "--at", "2", "--apply"], w.io)).toBe(1);
  expect(w.linear.writes).toHaveLength(1);
  expect(w.err()).toContain("Create: Spec 2 — Search images");
  expect(w.err()).not.toContain("Share a list");
});

test("truncated program reads refuse writes and invalid positions refuse the plan", async () => {
  const w = setup();
  w.io.fetch = recordedFetch({
    linear: (r) => {
      const page = r.Children[0]?.data.issues.pageInfo;
      if (page) {
        page.hasNextPage = true;
        page.endCursor = null;
      }
    },
  }).fetch;
  expect(await run(["spec", "add", "Search images", "--apply"], w.io)).toBe(2);
  expect(w.err()).toContain("incomplete");
  expect(w.linear.writes).toEqual([]);
  for (const at of ["0", "no", "1.5", "4", "1e0", ""]) {
    const invalid = setup();
    expect(await run(["spec", "add", "Search images", "--at", at, "--apply"], invalid.io)).toBe(2);
    expect(invalid.linear.writes).toEqual([]);
  }
});

test("a stored worker session is refused before any key request, even with an environment key", async () => {
  const home = await mkdtemp(join(tmpdir(), "armada-spec-worker-"));
  dirs.push(home);
  await mkdir(join(home, "armada"));
  await writeFile(
    join(home, "armada", "credentials"),
    `ARMADA_WORKER_SESSION_DEMO_7=${formatWorkerSession({
      api: "https://armada.example.test",
      token: "armada_worker_synthetic",
      ticket: "DEMO-7",
      project: "widgets",
      organization: "org-1",
      id: "worker-1",
    })}\n`,
  );
  const w = setup();
  w.io.env.XDG_CONFIG_HOME = home;
  w.io.gitBranch = () => "feature/demo-7-spec";
  w.io.fetch = async () => {
    throw new Error("must not fetch keys or Linear");
  };
  expect(await run(["spec", "add", "Search images", "--apply"], w.io)).toBe(2);
  expect(w.err()).toContain("coordinator-only");
  expect(w.linear.writes).toEqual([]);
});
