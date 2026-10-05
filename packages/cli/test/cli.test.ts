import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GITHUB_GRAPHQL, LINEAR_ENDPOINT } from "../../core/src/index.ts";
import { memoryFleet } from "../../core/test/memory-fleet.ts";
import { ARMADA_URL, DEMO_TOML, fakeArmada, NOW, recordedFetch } from "../../core/test/support.ts";
import { version } from "../package.json" with { type: "json" };
import { type Io, run } from "../src/cli.ts";
import { renderStatus } from "../src/render.ts";

function fakeIo(
  files: Record<string, string>,
  env: Record<string, string> = { LINEAR_API_KEY: "k", GITHUB_TOKEN: "t" },
) {
  const out: string[] = [];
  const err: string[] = [];
  const io: Io = {
    cwd: "/work/widgets/packages/app",
    env,
    readFile: async (path) => files[path] ?? null,
    stdout: (t) => out.push(t),
    stderr: (t) => err.push(t),
    ghToken: () => null,
    fetch: recordedFetch().fetch,
    now: () => NOW,
  };
  return { io, out: () => out.join(""), err: () => err.join("") };
}

describe("armada status", () => {
  test("human status shows the recorded profile and reason", async () => {
    const { io, out } = fakeIo({ "/work/widgets/armada.toml": DEMO_TOML });
    expect(await run(["status", "--json"], io)).toBe(0);
    const report = JSON.parse(out());
    report.inFlight[0].profile = "backend";
    report.inFlight[0].profileReason = "mostly CLI and core rules";
    expect(renderStatus(report)).toContain("Profile: backend — mostly CLI and core rules");
    report.inFlight[0].phase = "shipping";
    report.inFlight[0].shippingStage = "review";
    expect(renderStatus(report)).toContain("shipping · review");
    report.inFlight[0].shippingStage = "ci";
    expect(renderStatus(report)).toContain("shipping · ci");
  });
  test("--json prints the report found from the nearest armada.toml", async () => {
    const { io, out } = fakeIo({ "/work/widgets/armada.toml": DEMO_TOML });
    expect(await run(["status", "--json"], io)).toBe(0);
    const report = JSON.parse(out());
    expect(report.project).toEqual({ name: "Widgets", slug: "widgets", repository: "acme/widgets" });
    expect(report.inFlight.map((t: { id: string }) => t.id)).toEqual(["DEMO-18", "DEMO-16", "DEMO-11"]);
    expect(report.frontier.map((t: { id: string }) => t.id)).toEqual(["DEMO-13", "DEMO-15"]);
  });

  test("prints a readable summary by default", async () => {
    const { io, out } = fakeIo({ "/work/widgets/armada.toml": DEMO_TOML });
    expect(await run(["status"], io)).toBe(0);
    expect(out()).toBe(`Widgets · DEMO-1 Widgets: sign in and share lists
Read 2026-03-04 10:00 UTC · Linear DEMO-1 · GitHub acme/widgets

In flight (3)
  DEMO-18  ready-to-merge               Codex · Grace Worker · reported 20 min ago
           Expire idle sessions [Spec 1]
           “PR #9, head 9f1c2d3e4b5a69788796a5b4c3d2e1f00a1b2c3d, CI green”
           PR #9 · CI success · mergeable
  DEMO-16  shipping · ci (status-line)  unassigned · reported 2 h ago
           Reset a forgotten password [Spec 1]
           “PR open, fixing CI”
           PR #8 · CI failure · mergeable
           ! silent, ci-failing, no-assignee, no-phase-label
  DEMO-11  implementing                 Claude Code · Ada Worker · reported 50 min ago
           Send a sign-in link by email [Spec 1]
           “plan approved, writing the email sender”
           plan: https://linear.app/acme/issue/DEMO-11#comment-c11b0000
           PR #7 · CI pending · mergeability unknown
           ! silent

Ready to start (1)
  DEMO-13  Show a sign-in page  (Spec 1 · unlocks 1 · critical path)

Unblocked but not marked ready (1)
  DEMO-15  Rate-limit sign-in attempts

Pull requests waiting (4)
  #7       DEMO-11 implementing · CI pending · mergeability unknown
           feat(auth): send a sign-in link
  #8       DEMO-16 shipping · ci · CI failure · mergeable
           feat(auth): reset a forgotten password
           ! failing: test
  #9       DEMO-18 ready-to-merge · CI success · mergeable
           feat(auth): expire idle sessions
  #10      no ticket · draft · no CI · mergeable
           chore: bump dependencies
`);
  });

  test("reads that failed part way are listed as warnings", async () => {
    const { io, out } = fakeIo({ "/work/widgets/armada.toml": DEMO_TOML });
    io.fetch = recordedFetch({
      linear: (r) => {
        const kid = r.Children[2]?.data.issues.nodes.find((n) => n.identifier === "DEMO-13");
        if (kid) Object.assign(kid.inverseRelations.pageInfo, { hasNextPage: true, endCursor: "r1" });
        (r as Record<string, unknown[]>).MoreRelations = [{ errors: [{ message: "Query too complex" }] }];
      },
    }).fetch;
    expect(await run(["status"], io)).toBe(0);
    expect(out()).toEndWith(
      "\nWarnings (1)\n  ! DEMO-13: could not read all its relations (Linear API: Query too complex); some may be missing\n",
    );
  });

  test("project skills that differ from the CLI's are named with the release the lock records", async () => {
    const root = await mkdtemp(join(tmpdir(), "armada-status-"));
    try {
      await mkdir(join(root, ".agents/skills/armada-worker"), { recursive: true });
      await writeFile(join(root, ".agents/skills/armada-worker/SKILL.md"), "an older worker skill");
      const entry = { source: "The-Vibe-Company/armada", ref: "v0.1.4", computedHash: "old" };
      await writeFile(
        join(root, "skills-lock.json"),
        JSON.stringify({ version: 1, skills: { "armada-worker": entry } }),
      );
      const { io, out } = fakeIo({ [join(root, "armada.toml")]: DEMO_TOML });
      io.cwd = root;
      expect(await run(["status", "--json"], io)).toBe(0);
      expect(JSON.parse(out()).warnings).toContain(
        `this project's Armada skills are 0.1.4 (armada-worker differs), the CLI is ${version}: run \`armada init\` and merge its PR (\`armada merge <n> --no-ticket\`)`,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a missing armada.toml or a missing key is a configuration error naming what is missing", async () => {
    const missing = fakeIo({});
    expect(await run(["status"], missing.io)).toBe(2);
    expect(missing.err()).toBe(
      "armada: no armada.toml found in /work/widgets/packages/app or any parent directory, so this is not a repository Armada runs\nNext: armada init to set this repository up, armada status --config <file> to use another armada.toml, or armada status --all to see the registered projects\n",
    );
    const claim = fakeIo({});
    expect(await run(["claim", "DEMO-7", "--runtime", "conductor", "--handle", "ws-1"], claim.io)).toBe(2);
    expect(claim.err()).toContain("armada claim --config <file> to use another armada.toml");

    const partial = fakeIo({ "/work/widgets/armada.toml": DEMO_TOML.replace('slug = "widgets"', "") });
    expect(await run(["status"], partial.io)).toBe(2);
    expect(partial.err()).toContain('missing required key "project.slug"');
  });

  test("a rejected Linear key fails with exit code 1 and a clear message", async () => {
    const { io, err } = fakeIo({ "/work/widgets/armada.toml": DEMO_TOML });
    io.fetch = async () => new Response("", { status: 401 });
    expect(await run(["status"], io)).toBe(1);
    expect(err()).toBe(
      "armada: Linear rejected the API key (HTTP 401); check LINEAR_API_KEY\nNext: armada auth status\n",
    );
  });

  test("LINEAR_API_KEY is required", async () => {
    const { io, err } = fakeIo({ "/work/widgets/armada.toml": DEMO_TOML }, {});
    expect(await run(["status"], io)).toBe(2);
    expect(err()).toContain("LINEAR_API_KEY is not set");
    expect(err()).toEndWith("\nNext: armada auth login\n");
  });
});

describe("armada help", () => {
  test("<command> --help prints that command only; --help and no command print every command", async () => {
    const claim = fakeIo({});
    expect(await run(["claim", "--help"], claim.io)).toBe(0);
    expect(claim.out()).toStartWith("Usage: armada claim [options]\n\n  claim <ticket> --runtime <name> --handle <id>");
    expect(claim.out()).not.toContain("report <phase>");
    expect(claim.out()).not.toContain("--ticket <id>");
    const report = fakeIo({});
    expect(await run(["report", "ready-to-merge", "-h"], report.io)).toBe(0);
    expect(report.out()).toContain("  report <phase>");
    expect(report.out()).toContain("--ticket <id>");
    expect(report.out()).not.toContain("  claim <ticket>");
    const doctor = fakeIo({});
    expect(await run(["doctor", "--help"], doctor.io)).toBe(0);
    expect(doctor.out()).not.toContain("--config");

    const all = fakeIo({});
    expect(await run(["--help"], all.io)).toBe(0);
    expect(all.out()).toContain("  claim <ticket>");
    expect(all.out()).toContain("  merge <pr>");
    const none = fakeIo({});
    expect(await run([], none.io)).toBe(2);
    expect(none.err()).toBe(all.out());
  });

  test("an unknown command or option names the help to read", async () => {
    const unknown = fakeIo({});
    expect(await run(["deploy"], unknown.io)).toBe(2);
    expect(unknown.err()).toBe('armada: unknown command "deploy"\nNext: armada --help, which lists every command\n');
    const option = fakeIo({});
    expect(await run(["report", "--force"], option.io)).toBe(2);
    expect(option.err()).toBe("armada: unknown option --force\nNext: armada report --help\n");
  });
});

describe("armada status --all", () => {
  const KEY = "armada_key_CANARY_registry";

  test("lists every project of the organization on Armada, each read with the armada.toml of its default branch", async () => {
    const store = memoryFleet();
    await store.upsertProject(
      { slug: "widgets", name: "Widgets", repository: "acme/widgets", programRoot: "DEMO-1" },
      NOW,
    );
    await store.upsertProject(
      { slug: "gadgets", name: "Gadgets", repository: "acme/gadgets", programRoot: "GADG-1" },
      NOW,
    );
    const armada = fakeArmada({ keys: { [KEY]: "registry" }, store });
    const { io, out, err } = fakeIo(
      {},
      { LINEAR_API_KEY: "k", GITHUB_TOKEN: "t", ARMADA_API_URL: ARMADA_URL, ARMADA_API_KEY: KEY },
    );
    const recorded = recordedFetch().fetch;
    const configs: Record<string, string | null> = { "acme/widgets": DEMO_TOML, "acme/gadgets": null };
    io.fetch = async (url, init) => {
      if (url.startsWith(`${ARMADA_URL}/`)) return armada.fetch(url, init);
      const body = JSON.parse(String(init.body)) as { query: string; variables: Record<string, string> };
      if (url === GITHUB_GRAPHQL && body.query.includes("query ArmadaConfig")) {
        const text = configs[`${body.variables.owner}/${body.variables.name}`] ?? null;
        return Response.json({ data: { repository: { object: text === null ? null : { text } } } });
      }
      // The second project's program root is gone from Linear.
      if (url === LINEAR_ENDPOINT && body.variables.id === "GADG-1") return Response.json({ data: { issue: null } });
      return recorded(url, init);
    };
    expect(await run(["status", "--all", "--json"], io)).toBe(1);
    expect(armada.calls.map((c) => [c.method, c.path, c.apiKey])).toEqual([
      ["GET", "projects", KEY],
      ["POST", "fleet/coordinator", KEY],
      ["POST", "fleet/coordinator", KEY],
    ]);
    const all = JSON.parse(out());
    expect(
      all.projects.map((p: { slug: string; error: string | null; configWarning: string | null }) => [
        p.slug,
        p.error,
        p.configWarning,
      ]),
    ).toEqual([
      [
        "gadgets",
        "Linear: program root GADG-1 not found",
        "armada.toml not read (not on the default branch of acme/gadgets); using the registry record with default labels and policy",
      ],
      ["widgets", null, null],
    ]);
    expect(all.projects[1].report.inFlight.map((t: { id: string }) => t.id)).toEqual(["DEMO-18", "DEMO-16", "DEMO-11"]);
    expect(out() + err()).not.toContain(KEY);
  });

  test("a project that keeps its own Linear key is read with it; the others with the organization's", async () => {
    const store = memoryFleet();
    await store.upsertProject(
      { slug: "widgets", name: "Widgets", repository: "acme/widgets", programRoot: "DEMO-1" },
      NOW,
    );
    await store.upsertProject(
      { slug: "gadgets", name: "Gadgets", repository: "acme/gadgets", programRoot: "GADG-1" },
      NOW,
    );
    const armada = fakeArmada({
      keys: { [KEY]: "registry" },
      store,
      vault: {
        linear: { apiKey: "lin_CANARY_org", scope: "organization" },
        projects: { widgets: "lin_CANARY_widgets" },
        now: () => NOW,
      },
    });
    const { io, out } = fakeIo({}, { GITHUB_TOKEN: "t", ARMADA_API_URL: ARMADA_URL, ARMADA_API_KEY: KEY });
    const recorded = recordedFetch().fetch;
    const roots: string[] = [];
    io.fetch = async (url, init) => {
      if (url.startsWith(`${ARMADA_URL}/`)) return armada.fetch(url, init);
      const body = JSON.parse(String(init.body)) as { query: string; variables: Record<string, string> };
      if (url === GITHUB_GRAPHQL && body.query.includes("query ArmadaConfig"))
        return Response.json({ data: { repository: { object: null } } });
      const root = body.variables.id;
      if (url === LINEAR_ENDPOINT && (root === "DEMO-1" || root === "GADG-1"))
        roots.push(`${root} ${new Headers(init.headers).get("authorization")}`);
      return recorded(url, init);
    };
    await run(["status", "--all", "--json"], io);
    expect(roots.sort()).toEqual(["DEMO-1 lin_CANARY_widgets", "GADG-1 lin_CANARY_org"]);
    // The project's key is asked for that project only.
    expect(armada.calls.filter((c) => c.path === "credentials").map((c) => c.body)).toEqual([
      {},
      { purpose: { project: "widgets" } },
    ]);
    expect(out()).not.toContain("lin_CANARY");
  });

  test("an organization with no project yet says how to register one", async () => {
    const armada = fakeArmada({ keys: { [KEY]: "registry" } });
    const { io, out } = fakeIo({}, { LINEAR_API_KEY: "k", ARMADA_API_URL: ARMADA_URL, ARMADA_API_KEY: KEY });
    io.fetch = armada.fetch;
    expect(await run(["status", "--all"], io)).toBe(0);
    expect(out()).toBe("No project is registered yet. Run `armada init` in a repository to register it.\n");
  });

  test("not signed in, it refuses and names armada login", async () => {
    const { io, err } = fakeIo({}, { LINEAR_API_KEY: "k" });
    io.fetch = async () => {
      throw new Error("no request expected");
    };
    expect(await run(["status", "--all"], io)).toBe(2);
    expect(err()).toBe(
      "armada: not signed in to Armada (armada.thevibecompany.co). A person signs in with `armada login`; a headless coordinator sets ARMADA_API_KEY to an organization API key\nNext: armada login\n",
    );
  });
});

test("Linear status retries print wait notices; exhausted reads still fail with an error and next step", async () => {
  for (const recover of [true, false]) {
    const { io, out, err } = fakeIo({ "/work/widgets/armada.toml": DEMO_TOML });
    const recorded = recordedFetch();
    const waits: number[] = [];
    let calls = 0;
    io.sleep = async (ms) => {
      waits.push(ms);
    };
    io.fetch = async (url, init) => {
      if (url === LINEAR_ENDPOINT && (++calls <= 2 || !recover)) return new Response("busy", { status: 503 });
      return recorded.fetch(url, init);
    };
    expect(await run(["status", "--json"], io)).toBe(recover ? 0 : 1);
    expect(waits).toHaveLength(2);
    expect(waits[0]).toBeGreaterThanOrEqual(800);
    expect(waits[0]).toBeLessThanOrEqual(1200);
    expect(waits[1]).toBeGreaterThanOrEqual(2400);
    expect(waits[1]).toBeLessThanOrEqual(3600);
    expect(err().match(/armada: Linear answered 503; trying again/g)).toHaveLength(2);
    if (recover) expect(JSON.parse(out()).project.slug).toBe("widgets");
    else {
      expect(out()).toBe("");
      expect(err()).toContain("armada: Linear API HTTP 503\nNext:");
    }
  }
});
