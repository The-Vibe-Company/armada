import { expect, test } from "bun:test";
import { run } from "../src/run.ts";
import { memorySessionStore } from "../src/session.ts";

const org = "11111111-1111-4111-8111-111111111111";
const id = "22222222-2222-4222-8222-222222222222";
const golden = { id, name: "web", provider: "boat", orgId: org };

test.each([
  { label: "unique name", rows: [golden], flags: [], removed: id },
  { label: "explicit org", rows: [golden], flags: ["--org", org], removed: id },
  {
    label: "provider selects one match",
    rows: [golden, { ...golden, id: "33333333-3333-4333-8333-333333333333", provider: "modal" }],
    flags: ["--provider", "boat"],
    removed: id,
  },
  {
    label: "duplicate provider names",
    rows: [golden, { ...golden, id: "33333333-3333-4333-8333-333333333333", provider: "modal" }],
    flags: [],
    removed: null,
  },
  {
    label: "duplicate org names",
    rows: [
      golden,
      { ...golden, id: "33333333-3333-4333-8333-333333333333", orgId: "44444444-4444-4444-8444-444444444444" },
    ],
    flags: ["--provider", "boat"],
    removed: null,
  },
  { label: "hidden or missing name", rows: [], flags: [], removed: null },
])("golden removal resolves $label without guessing", async ({ rows, flags, removed }) => {
  const calls: { path: string; body: unknown }[] = [];
  let errors = "";
  const code = await run(
    ["golden", "remove", "web", ...flags],
    {
      out: () => {},
      err: (s) => {
        errors += s;
      },
    },
    {
      auth: {
        env: { ARMADA_TOKEN: "fixture-owner" },
        session: memorySessionStore(),
        out: () => {},
        err: () => {},
        now: () => new Date(0),
        open: () => {},
        fetch: async (url, init) => {
          expect(new Headers(init?.headers).get("authorization")).toBe("Bearer fixture-owner");
          const path = new URL(String(url)).pathname;
          const body = JSON.parse(String(init?.body));
          calls.push({ path, body });
          if (path === "/api/v1/golden/list") return Response.json({ goldens: rows });
          return Response.json({ id, removedAt: "2026-11-14T00:00:00Z", artifacts: "retained" });
        },
      },
    },
  );
  expect(calls[0]).toEqual({
    path: "/api/v1/golden/list",
    body: flags.some((flag) => flag === "--org") ? { org } : {},
  });
  if (removed) {
    expect(code).toBe(0);
    expect(calls.slice(1)).toEqual([{ path: "/api/v1/golden/remove", body: { id: removed, org } }]);
  } else {
    expect(code).toBe(1);
    expect(calls).toHaveLength(1);
    expect(errors).toContain("snapshot list --json");
    expect(errors).toContain("Nothing was removed");
  }
});
