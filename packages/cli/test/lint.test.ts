import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEMO_TOML, NOW, recordedFetch } from "../../core/test/support.ts";
import { type Io, run } from "../src/cli.ts";

const homes: string[] = [];
afterEach(async () => {
  for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true });
});

// Owner flow: strict lint fails before launch; brief warns but still gives the prompt.
test("ready lint batches descriptions, gives fixes and an error exit; default lint and brief warn without blocking", async () => {
  for (const strict of [true, false]) {
    const home = await mkdtemp(join(tmpdir(), "armada-lint-"));
    homes.push(home);
    let recorded = recordedFetch();
    const batch: { ids: string[]; after: string | null }[] = [];
    const out: string[] = [];
    const err: string[] = [];
    const events: string[] = [];
    const config = `${DEMO_TOML}${strict ? "\n[tracker.lint]\ntitle_max = 60\n" : ""}`;
    const io: Io = {
      cwd: "/work/widgets",
      env: { LINEAR_API_KEY: "synthetic-key", XDG_CONFIG_HOME: home },
      readFile: async (path) => (path === "/work/widgets/armada.toml" ? config : null),
      stdout: (s) => {
        out.push(s);
        events.push(`out:${s}`);
      },
      stderr: (s) => {
        err.push(s);
        events.push(`err:${s}`);
      },
      ghToken: () => null,
      now: () => NOW,
      fetch: async (url, init) => {
        const body = init.body ? JSON.parse(String(init.body)) : {};
        if (body.query?.includes("query TicketDescriptions")) {
          batch.push(body.variables);
          expect(body.query).toContain("filter: { id: { in: $ids } }");
          expect(body.query).not.toContain("labels(");
          return Response.json({
            data: {
              issues: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: body.variables.ids.map((id: string) => ({
                  id,
                  identifier: id.replace("uuid-", "").toUpperCase(),
                  title: "Change loadState",
                  description: "## In short\n* **What changes:** Search images.\n",
                })),
              },
            },
          });
        }
        if (body.query?.includes("query Brief("))
          return Response.json({
            data: {
              issue: {
                identifier: "DEMO-13",
                title: "Change loadState",
                url: "https://linear.app/acme/issue/DEMO-13",
                branchName: "feature/demo-13-search-images",
                description: "## In short\n* **What changes:** Search images.",
                state: { name: "Todo", type: "unstarted" },
                parent: {
                  identifier: "DEMO-2",
                  title: "Spec 1 — Search images",
                  url: "https://linear.app/acme/issue/DEMO-2",
                },
                labels: { nodes: [], pageInfo: { hasNextPage: false } },
                comments: { nodes: [], pageInfo: { hasNextPage: false } },
                inverseRelations: { nodes: [], pageInfo: { hasNextPage: false } },
              },
            },
          });
        return recorded.fetch(url, init);
      },
    };
    expect(await run(["lint", "--ready"], io)).toBe(strict ? 1 : 0);
    expect(batch).toHaveLength(1);
    expect(batch[0]?.ids).toContain("uuid-demo-13");
    expect(batch[0]?.ids).toContain("uuid-demo-2"); // open spec
    expect(batch[0]?.ids).not.toContain("uuid-demo-14"); // blocked ticket
    expect(out.join("")).toContain(`${strict ? "error" : "warning"}:`);
    expect(out.join("")).toContain('Fix: Add a "Why:" part');
    expect(out.join("")).toContain("camelCase tokens");

    // Explicit selection can inspect blocked tickets and deduplicates identifiers.
    recorded = recordedFetch();
    out.length = 0;
    expect(await run(["lint", "DEMO-13", "demo-13", "DEMO-14", "--json"], io)).toBe(strict ? 1 : 0);
    expect(batch[1]?.ids).toEqual(["uuid-demo-13", "uuid-demo-14"]);
    const explicit = JSON.parse(out.join(""));
    expect(explicit.tickets.map((t: { id: string }) => t.id)).toEqual(["DEMO-13", "DEMO-14"]);
    expect(explicit.errors > 0).toBe(strict);

    // Fresh recorded program queues for the brief read.
    const second = recordedFetch();
    const firstFetch = io.fetch;
    io.fetch = async (url, init) => {
      const body = init.body ? JSON.parse(String(init.body)) : {};
      if (body.query?.includes("query Brief(")) return firstFetch?.(url, init) as Promise<Response>;
      return second.fetch(url, init);
    };
    out.length = 0;
    events.length = 0;
    expect(await run(["brief", "DEMO-13", "--prompt"], io)).toBe(0);
    expect(out.join("")).toContain("# DEMO-13");
    expect(err.join("")).toContain("Missing Why");
    expect(events.findIndex((e) => e.includes("Missing Why"))).toBeLessThan(
      events.findIndex((e) => e.startsWith("out:#")),
    );
  }
});
