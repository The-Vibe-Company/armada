import { expect, test } from "bun:test";
import { run } from "../src/run.ts";
import { memorySessionStore } from "../src/session.ts";

const org = "11111111-1111-4111-8111-111111111111";
const golden = "22222222-2222-4222-8222-222222222222";
const pins = ["team/testing@1.2.3", "review-code@2.1.0"] as const;

async function invoke(
  argv: string[],
  options: {
    selected?: string | null;
    response?: unknown;
    orgs?: { id: string; name: string; role: string }[];
    anonymous?: boolean;
  } = {},
) {
  let out = "",
    err = "";
  const requests: { path: string; body: Record<string, unknown> }[] = [];
  const code = await run(
    argv,
    {
      out: (text) => {
        out += text;
      },
      err: (text) => {
        err += text;
      },
    },
    {
      auth: {
        out: (text) => {
          out += text;
        },
        err: (text) => {
          err += text;
        },
        env: options.anonymous
          ? {}
          : { ARMADA_TOKEN: "fixture-armada-session", ARMADA_URL: "https://armada.example.invalid" },
        session: memorySessionStore(),
        now: () => new Date(),
        open: () => {},
        preferences: {
          read: async () => (options.selected === null ? undefined : (options.selected ?? org)),
          write: async () => {},
        },
        fetch: async (input, init) => {
          const request = input instanceof Request ? new Request(input, init) : new Request(String(input), init);
          const path = new URL(request.url).pathname;
          requests.push({ path, body: (await request.json()) as Record<string, unknown> });
          return Response.json(
            path.endsWith("org/list")
              ? { orgs: options.orgs ?? [{ id: org, name: "Team", role: "admin" }] }
              : (options.response ?? { skills: pins, token: "DO NOT DISPLAY", value_enc: "DO NOT DISPLAY" }),
          );
        },
      },
    },
  );
  return { code, out, err, requests };
}

test("defaults get/set send exact scope targets through the API and JSON projects only pins", async () => {
  for (const scope of ["personal", "org", "golden"] as const) {
    for (const action of ["get", "set"] as const) {
      const flags = scope === "golden" ? ["--golden-id", golden] : [];
      const result = await invoke([
        "skills",
        "defaults",
        action,
        "--scope",
        scope,
        ...flags,
        "--org",
        org,
        "--json",
        ...(action === "set" ? pins.flatMap((pin) => ["--skill", pin]) : []),
      ]);
      expect(result.code).toBe(0);
      expect(result.requests).toEqual([
        {
          path: `/api/v1/skills/defaults/${action}`,
          body: {
            org,
            scope,
            ...(scope === "golden" ? { goldenId: golden } : {}),
            ...(action === "set" ? { skills: pins } : {}),
          },
        },
      ]);
      expect(JSON.parse(result.out)).toEqual({ skills: pins });
      expect(result.out + result.err).not.toContain("DO NOT DISPLAY");
    }
  }
});

test("set requires deliberate replacement or explicit clear, while get defaults to personal and selected org", async () => {
  const read = await invoke(["skills", "defaults", "get"]);
  expect(read.code).toBe(0);
  expect(read.requests).toEqual([{ path: "/api/v1/skills/defaults/get", body: { org, scope: "personal" } }]);
  expect(read.out).toContain("review-code@2.1.0");
  const clear = await invoke(["skills", "defaults", "set", "--clear", "--json"], { response: { skills: [] } });
  expect(clear.code).toBe(0);
  expect(clear.requests).toEqual([
    { path: "/api/v1/skills/defaults/set", body: { org, scope: "personal", skills: [] } },
  ]);
  expect(JSON.parse(clear.out)).toEqual({ skills: [] });
});

test("organization names resolve exactly and unambiguously while UUID preferences need no list", async () => {
  const named = await invoke(["skills", "defaults", "get", "--org", "tEaM"]);
  expect(named.code).toBe(0);
  expect(named.requests).toEqual([
    { path: "/api/v1/org/list", body: {} },
    { path: "/api/v1/skills/defaults/get", body: { org, scope: "personal" } },
  ]);
  const selectedName = await invoke(["skills", "defaults", "get"], { selected: "Team" });
  expect(selectedName.requests).toEqual(named.requests);
  for (const orgs of [
    [],
    [
      { id: org, name: "Team", role: "admin" },
      { id: golden, name: "team", role: "member" },
    ],
  ]) {
    const result = await invoke(["skills", "defaults", "get", "--org", "Team"], { orgs });
    expect(result.code).toBe(2);
    expect(result.requests).toEqual([{ path: "/api/v1/org/list", body: {} }]);
  }
  const missing = await invoke(["skills", "defaults", "get"], { selected: null });
  expect(missing.code).toBe(2);
  expect(missing.requests).toEqual([]);
});

test("invalid flags and pins fail before organization lookup or any API request", async () => {
  const invalid = [
    ["get", "--skill", pins[0]],
    ["get", "--clear"],
    ["set"],
    ["set", "--clear", "--skill", pins[0]],
    ["get", "--scope", "user"],
    ["get", "--scope", "golden"],
    ["get", "--golden-id", golden],
    ["get", "--scope", "golden", "--golden-id", "not-a-uuid"],
    ["get", "--json", "--json"],
    ["set", "--clear", "--clear"],
    ["get", "--scope", "personal", "--scope", "org"],
    ["get", "--org", org, "--org", org],
    ["get", "--scope", "golden", "--golden-id", golden, "--golden-id", golden],
    ["get", "--file", "DO NOT DISPLAY"],
    ["get", "--unknown=DO NOT DISPLAY"],
    ["get", "positional"],
    ...[
      "review-code@latest",
      "review-code@^2.0.0",
      "armada-tools@1.0.0",
      "team/armada-tools@1.0.0",
      "x".repeat(257),
    ].map((pin) => ["set", "--skill", pin]),
    ["set", "--skill", "review-code@1.0.0", "--skill", "team/review-code@2.0.0"],
    ["set", ...Array.from({ length: 21 }, (_, index) => ["--skill", `skill-${index}@1.0.0`]).flat()],
  ];
  for (const args of invalid) {
    const result = await invoke(["skills", "defaults", ...(args as string[])], { selected: "Team" });
    expect(result.code).toBe(2);
    expect(result.requests).toEqual([]);
    expect(result.out + result.err).not.toContain("DO NOT DISPLAY");
  }
});

test("unreadable defaults responses never appear as empty records or expose arbitrary server fields", async () => {
  for (const response of [{}, { skills: null }, { skills: ["latest"], token: "DO NOT DISPLAY" }]) {
    const result = await invoke(["skills", "defaults", "get", "--json"], { response });
    expect(result.code).toBe(1);
    expect(result.out).toBe("");
    expect(result.err).not.toContain("DO NOT DISPLAY");
  }
});

test("defaults help works without login and explains exact pins, replacement and precedence without credential flags", async () => {
  const result = await invoke(["skills", "defaults", "--help"], { anonymous: true, selected: null });
  expect(result.code).toBe(0);
  expect(result.requests).toEqual([]);
  expect(result.out).toContain("environment, organization, personal, template, explicit");
  expect(result.out).toContain("--clear");
  expect(result.out).toContain("org/slug@1.2.3");
  expect(result.out).toContain("slug@1.2.3");
  expect(result.out).not.toContain("--api-key");
  expect(result.out).not.toContain("BOAT_API_KEY");
});
