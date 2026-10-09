import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BUNDLED_SKILLS,
  GITHUB_GRAPHQL,
  LINEAR_ENDPOINT,
  machinePaths,
  updateWatchState,
} from "../../core/src/index.ts";
import { memoryFleet } from "../../core/test/memory-fleet.ts";
import { ARMADA_URL, DEMO_TOML, FakeLinear, fakeArmada, NOW, recordedFetch } from "../../core/test/support.ts";
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

describe("project config resolution", () => {
  function pathsOf(home: string) {
    const paths = machinePaths({ XDG_CONFIG_HOME: home });
    if (!paths) throw new Error("temporary machine store missing");
    return paths;
  }

  async function withMachine(check: (home: string) => Promise<void>) {
    const home = await mkdtemp(join(tmpdir(), "armada-config-"));
    try {
      await check(home);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  }

  test("--config overrides ARMADA_CONFIG, --project and the upward search", async () => {
    await withMachine(async (home) => {
      const { io, out } = fakeIo(
        { "/tmp/chosen.toml": DEMO_TOML, "/tmp/armada.toml": "invalid" },
        { XDG_CONFIG_HOME: home, ARMADA_CONFIG: "missing.toml", LINEAR_API_KEY: "k", GITHUB_TOKEN: "t" },
      );
      io.cwd = "/tmp";
      expect(await run(["status", "--config", "chosen.toml", "--project", "unknown", "--json"], io)).toBe(0);
      expect(JSON.parse(out()).project.slug).toBe("widgets");
    });
  });

  test("ARMADA_CONFIG resolves absolute and relative paths from /tmp before --project", async () => {
    await withMachine(async (home) => {
      for (const config of ["/tmp/settings/project.toml", "settings/project.toml"]) {
        const { io, out } = fakeIo(
          { "/tmp/settings/project.toml": DEMO_TOML, "/tmp/armada.toml": "invalid" },
          { XDG_CONFIG_HOME: home, ARMADA_CONFIG: config, LINEAR_API_KEY: "k", GITHUB_TOKEN: "t" },
        );
        io.cwd = "/tmp";
        expect(await run(["status", "--project=unknown", "--json"], io)).toBe(0);
        expect(JSON.parse(out()).project.slug).toBe("widgets");
      }
    });
  });

  test("ARMADA_CONFIG selects the inbox project from /tmp", async () => {
    await withMachine(async (home) => {
      const store = memoryFleet();
      const key = "armada_key_CANARY_config";
      const api = fakeArmada({ store, keys: { [key]: "config test" } });
      const { io, out } = fakeIo(
        { "/checkout/armada.toml": DEMO_TOML },
        {
          XDG_CONFIG_HOME: home,
          ARMADA_CONFIG: "/checkout/armada.toml",
          ARMADA_API_KEY: key,
          ARMADA_API_URL: ARMADA_URL,
          LINEAR_API_KEY: "k",
        },
      );
      io.cwd = "/tmp";
      io.fetch = api.fetch;
      expect(await run(["inbox", "--json"], io)).toBe(0);
      expect(JSON.parse(out()).project).toBe("widgets");
    });
  });

  test("--project finds a previously watched checkout from /tmp before upward search", async () => {
    await withMachine(async (home) => {
      await updateWatchState(pathsOf(home), "widgets", { root: "/checkout" });
      const { io, out } = fakeIo(
        { "/checkout/armada.toml": DEMO_TOML, "/tmp/armada.toml": "invalid" },
        { XDG_CONFIG_HOME: home, LINEAR_API_KEY: "k", GITHUB_TOKEN: "t" },
      );
      io.cwd = "/tmp";
      expect(await run(["--project", "widgets", "status", "--json"], io)).toBe(0);
      expect(JSON.parse(out()).project.slug).toBe("widgets");
    });
  });

  test("spec renumber honors environment and project selectors from /tmp", async () => {
    await withMachine(async (home) => {
      await updateWatchState(pathsOf(home), "widgets", { root: "/checkout" });
      for (const selector of ["env", "project"]) {
        const { io, out } = fakeIo(
          { "/checkout/armada.toml": DEMO_TOML },
          {
            XDG_CONFIG_HOME: home,
            LINEAR_API_KEY: "synthetic-key",
            ...(selector === "env" ? { ARMADA_CONFIG: "/checkout/armada.toml" } : {}),
          },
        );
        io.cwd = "/tmp";
        const linear = new FakeLinear();
        io.linearWriter = () => linear;
        const args = selector === "project" ? ["--project", "widgets"] : [];
        expect(await run(["spec", "renumber", "--json", ...args], io)).toBe(0);
        expect(JSON.parse(out())).toMatchObject({ applied: false, create: null, created: null });
        expect(linear.writes).toEqual([]);
      }
    });
  });

  test("--project uses the most recent named coordinator's watch root", async () => {
    await withMachine(async (home) => {
      const paths = pathsOf(home);
      await updateWatchState(paths, "widgets", { root: "/old", readAt: "2026-03-01T00:00:00Z" });
      await updateWatchState(paths, "widgets@alpha", { root: "/recent", readAt: "2026-03-04T00:00:00Z" });
      await updateWatchState(paths, "widgets@beta", { root: "/older", readAt: "2026-03-02T00:00:00Z" });
      const { io, out } = fakeIo(
        { "/recent/armada.toml": DEMO_TOML },
        { XDG_CONFIG_HOME: home, LINEAR_API_KEY: "k", GITHUB_TOKEN: "t" },
      );
      io.cwd = "/tmp";
      expect(await run(["status", "--project", "widgets", "--json"], io)).toBe(0);
      expect(JSON.parse(out()).project.slug).toBe("widgets");
    });
  });

  test("unknown projects list valid known slugs and suggest --config without falling back", async () => {
    await withMachine(async (home) => {
      const paths = pathsOf(home);
      await updateWatchState(paths, "widgets@alpha", { root: "/widgets" });
      await updateWatchState(paths, "gadgets", { root: "/gadgets" });
      await writeFile(join(paths.dir, "watch", "broken.json"), "not JSON");
      await updateWatchState(paths, "empty", { root: null });
      const { io, err } = fakeIo({ "/tmp/armada.toml": DEMO_TOML }, { XDG_CONFIG_HOME: home });
      io.cwd = "/tmp";
      expect(await run(["status", "--project", "unknown"], io)).toBe(2);
      expect(err()).toContain('unknown project "unknown"');
      expect(err()).toContain("Known projects on this machine: gadgets, widgets");
      expect(err()).toContain("armada status --config <file>");
      const empty = fakeIo({}, {});
      expect(await run(["status", "--project", "unknown"], empty.io)).toBe(2);
      expect(empty.err()).toContain("Known projects on this machine: none");
    });
  });

  test("explicit missing files and removed watched checkouts fail without upward fallback", async () => {
    await withMachine(async (home) => {
      await updateWatchState(pathsOf(home), "widgets", { root: "/removed" });
      for (const selector of ["config", "env", "project"]) {
        const { io, err } = fakeIo(
          { "/tmp/armada.toml": DEMO_TOML },
          { XDG_CONFIG_HOME: home, ...(selector === "env" ? { ARMADA_CONFIG: "missing.toml" } : {}) },
        );
        io.cwd = "/tmp";
        const args = selector === "env" ? [] : [`--${selector}`, selector === "config" ? "missing.toml" : "widgets"];
        expect(await run(["status", ...args], io)).toBe(2);
        expect(err()).toContain(
          selector === "project" ? "/removed/armada.toml does not exist" : "/tmp/missing.toml does not exist",
        );
        expect(err()).toContain("--config <file>");
      }
    });
  });

  test("hook stop ignores external selectors and keeps the hook's cwd", async () => {
    await withMachine(async (home) => {
      await updateWatchState(pathsOf(home), "widgets", {
        root: "/coordinator",
        inFlight: ["DEMO-11"],
      });
      const { io, out } = fakeIo(
        { "/coordinator/armada.toml": DEMO_TOML, "/worker/armada.toml": DEMO_TOML },
        { XDG_CONFIG_HOME: home, ARMADA_CONFIG: "/coordinator/armada.toml" },
      );
      io.cwd = "/coordinator";
      io.readStdin = async () => JSON.stringify({ cwd: "/worker" });
      expect(await run(["hook", "stop", "--config", "/coordinator/armada.toml", "--project", "widgets"], io)).toBe(0);
      expect(out()).toBe("");
      io.readStdin = async () => JSON.stringify({ cwd: "/coordinator" });
      expect(await run(["hook", "stop"], io)).toBe(0);
      expect(JSON.parse(out()).decision).toBe("block");
    });
  });
});

describe("armada status", () => {
  test("status mine uses the selected coordinator and annotates other launches", async () => {
    const root = await mkdtemp(join(tmpdir(), "armada-status-mine-"));
    try {
      const store = memoryFleet();
      const { io, out } = fakeIo(
        { "/work/widgets/armada.toml": DEMO_TOML },
        {
          XDG_CONFIG_HOME: root,
          ARMADA_API_KEY: "synthetic-coordinator",
          ARMADA_API_URL: ARMADA_URL,
          ARMADA_COORDINATOR: "front",
          LINEAR_API_KEY: "k",
          GITHUB_TOKEN: "t",
        },
      );
      const api = fakeArmada({ keys: { "synthetic-coordinator": "fleet" }, store });
      const sources = recordedFetch();
      io.fetch = (url, init) => (url.startsWith(ARMADA_URL) ? api.fetch(url, init) : sources.fetch(url, init));
      await store.saveRuntimeHandle({
        project: "widgets",
        ticket: "DEMO-11",
        coordinator: "front",
        runtime: "conductor",
        handle: "ws/front",
        branch: null,
        at: NOW,
      });
      store.launches.push({
        project: "widgets",
        ticket: "DEMO-13",
        coordinator: "default",
        launchedAt: NOW.toISOString(),
        tokenUsedAt: null,
        runtime: null,
        handle: null,
        endedAt: null,
      });
      expect(await run(["status", "--mine"], io)).toBe(0);
      expect(out()).toContain("In flight (1)");
      expect(out()).toContain("launching by default");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

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

  test("status announces setup drift once a day outside its ordinary warnings", async () => {
    const root = await mkdtemp(join(tmpdir(), "armada-status-"));
    try {
      await mkdir(join(root, ".agents/skills/armada-worker"), { recursive: true });
      await writeFile(join(root, ".agents/skills/armada-worker/SKILL.md"), "an older worker skill");
      const entry = { source: "The-Vibe-Company/armada", ref: "v0.1.4", computedHash: "old" };
      await writeFile(
        join(root, "skills-lock.json"),
        JSON.stringify({ version: 1, skills: { "armada-worker": entry } }),
      );
      const { io, out, err } = fakeIo(
        { [join(root, "armada.toml")]: DEMO_TOML },
        { LINEAR_API_KEY: "k", GITHUB_TOKEN: "t", XDG_CONFIG_HOME: root },
      );
      io.cwd = root;
      expect(await run(["status", "--json"], io)).toBe(0);
      expect(JSON.parse(out()).warnings).toEqual([]);
      const line = `armada: This project's Armada setup is behind ${version}: armada upgrade, then merge the setup pull request it opens.\n`;
      expect(err()).toBe(line);
      io.fetch = recordedFetch().fetch;
      expect(await run(["status", "--json"], io)).toBe(0);
      expect(err()).toBe(line);
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
    const home = await mkdtemp(join(tmpdir(), "armada-missing-key-"));
    try {
      // Both no machine home and an actual empty machine store reach the same CLI recovery contract.
      for (const env of [{}, { XDG_CONFIG_HOME: home }] as Record<string, string>[]) {
        const key = fakeIo({ "/work/widgets/armada.toml": DEMO_TOML }, env);
        expect(await run(["status"], key.io)).toBe(2);
        expect(key.err()).toContain("LINEAR_API_KEY is not set. Set it in the environment, run `armada auth login`");
        expect(key.err()).toEndWith("\nNext: armada auth login\n");
      }
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("a rejected Linear key fails with exit code 1 and a clear message", async () => {
    const { io, err } = fakeIo({ "/work/widgets/armada.toml": DEMO_TOML });
    io.fetch = async () => new Response("", { status: 401 });
    expect(await run(["status"], io)).toBe(1);
    expect(err()).toBe(
      "armada: Linear rejected the API key (HTTP 401); check LINEAR_API_KEY\nNext: armada auth status\n",
    );
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
    expect(await run(["frobnicate"], unknown.io)).toBe(2);
    expect(unknown.err()).toBe(
      'armada: unknown command "frobnicate"\nNext: armada --help, which lists every command\n',
    );
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
    await store.startJob({ project: "widgets", ticket: "DEMO-11", name: "eval", startedBy: "worker", at: NOW });
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
      ["POST", "fleet/job/list", KEY],
      ["POST", "fleet/job/list", KEY],
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
    expect(all.projects[1].report.jobs[0]).toMatchObject({ ticket: "DEMO-11", state: "starting", name: "eval" });
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

describe("armada skill", () => {
  test("prints the installed bundle and linked files without config, credentials, filesystem or network", async () => {
    for (const [name, file] of [
      ["armada-worker", "SKILL.md"],
      ["armada-coordinator", "MERGE.md"],
      ["review-code-dev", "scripts/ocr.py"],
    ]) {
      const { io, out, err } = fakeIo({}, { ARMADA_WORKER_SESSION_DEMO_1: "synthetic-session" });
      io.readFile = async () => {
        throw new Error("must not read filesystem");
      };
      io.fetch = async () => {
        throw new Error("must not call network");
      };
      expect(await run(["skill", name ?? "", ...(file === "SKILL.md" ? [] : [file ?? ""])], io)).toBe(0);
      expect(out()).toBe(
        BUNDLED_SKILLS.find((s) => s.name === name)?.files.find((f) => f.path === file)?.content ?? "",
      );
      expect(err()).toBe("");
    }
  });
  test("rejects missing, unknown and extra arguments and paths outside the bundled skill", async () => {
    for (const args of [
      [],
      ["unknown"],
      ["armada-worker", "../armada-coordinator/SKILL.md"],
      ["armada-worker", "/SKILL.md"],
      ["armada-worker", "missing.md"],
      ["armada-worker", "SKILL.md", "extra"],
    ]) {
      const { io, out, err } = fakeIo({}, {});
      expect(await run(["skill", ...args], io)).toBe(2);
      expect(out()).toBe("");
      expect(err()).toBeTruthy();
    }
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
