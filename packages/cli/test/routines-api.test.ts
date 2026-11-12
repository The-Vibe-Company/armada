import { expect, test } from "bun:test";
import { run } from "../src/run.ts";
import { memorySessionStore } from "../src/session.ts";

const org = "11111111-1111-4111-8111-111111111111";
const id = "22222222-2222-4222-8222-222222222222";
const templateId = "33333333-3333-4333-8333-333333333333";
const config = {
  name: "nightly",
  templateId,
  templateRevision: 2,
  prompt: "Inspect\nexact bytes\n",
  cron: "0 9 * * MON-FRI",
  timezone: "Europe/Paris",
  ttlSeconds: 600,
  maxRunsPerDay: 2,
};
const { name: _createName, ...createConfig } = config;
const routine = {
  ...config,
  intervalHours: null,
  scheduleDescription: "At 09:00, Monday through Friday, Europe/Paris",
  id,
  orgId: org,
  scope: "personal",
  status: "paused",
  version: 3,
  nextDueAt: null,
  consecutiveFailures: 0,
};
const history = {
  items: [
    {
      id: "run",
      scheduledDueAt: "2026-11-11T00:00:00Z",
      state: "skipped",
      reason: "previous_run_alive",
      reasonHelp: "Previous run is still alive.",
      taskState: null,
      sandboxId: null,
    },
  ],
};
async function invoke(
  args: string[],
  options: {
    file?: string;
    stdin?: string;
    items?: unknown[];
    selected?: string;
    status?: number;
    getReply?: unknown;
    reply?: unknown;
    token?: string;
    readError?: boolean;
  } = {},
) {
  let out = "",
    err = "";
  const requests: Request[] = [];
  const code = await run(
    ["routine", ...args],
    {
      out: (s) => {
        out += s;
      },
      err: (s) => {
        err += s;
      },
    },
    {
      auth: {
        out: (s) => {
          out += s;
        },
        err: (s) => {
          err += s;
        },
        env: { ARMADA_URL: "https://armada.invalid", ARMADA_TOKEN: options.token ?? "fixture-routine-bearer" },
        session: memorySessionStore(),
        now: () => new Date(),
        open: () => {},
        preferences: { read: async () => options.selected ?? org, write: async () => {} },
        fetch: async (input, init) => {
          const request = input instanceof Request ? new Request(input, init) : new Request(input.toString(), init);
          requests.push(request);
          if (request.url.endsWith("/org/list")) return Response.json({ orgs: [{ id: org, name: "Example" }] });
          if (request.url.endsWith("/routines/get") && options.getReply !== undefined)
            return Response.json(options.getReply);
          if (request.url.endsWith("/routines/list")) return Response.json({ items: options.items ?? [routine] });
          return Response.json(
            options.reply ?? (request.url.endsWith("/routines/history") ? history : { item: routine }),
            { status: options.status ?? 200 },
          );
        },
      },
      readFile: async () => {
        if (options.readError) throw Error("private file contents must not leak");
        return options.file ?? JSON.stringify(config);
      },
      readStdin: async () => options.stdin ?? config.prompt,
    },
  );
  return { code, out, err, requests };
}

// CLI owns argv-to-authenticated-API translation; SQL authorization is owned by server tests.
test("all eight routine commands use the API-only contract and preserve JSON envelopes", async () => {
  const { name: _, ...create } = config;
  const cases: { args: string[]; route: string; body: Record<string, unknown>; file?: string }[] = [
    {
      args: ["create", "nightly", "--file", "config.json"],
      route: "create",
      body: { org, ...config, scope: "personal" },
      file: JSON.stringify(create),
    },
    { args: ["list"], route: "list", body: { org } },
    { args: ["show", id], route: "get", body: { org, id } },
    {
      args: ["update", id, "--expected-version", "3", "--file", "config.json"],
      route: "update",
      body: { org, id, expectedVersion: 3, ...config },
    },
    ...["enable", "pause", "delete"].map((action) => ({
      args: [action, id, "--expected-version", "3"],
      route: action,
      body: { org, id, expectedVersion: 3 },
    })),
    { args: ["runs", id], route: "history", body: { org, id } },
  ];
  for (const entry of cases) {
    const response = await invoke([...entry.args, "--json"], entry.file === undefined ? {} : { file: entry.file });
    expect(response.code).toBe(0);
    expect(response.err).toBe("");
    expect(response.requests).toHaveLength(1);
    const request = response.requests[0]!;
    expect(request.url).toBe(`https://armada.invalid/api/v1/routines/${entry.route}`);
    expect(request.method).toBe("POST");
    expect(request.headers.get("authorization")).toBe("Bearer fixture-routine-bearer");
    expect(await request.json()).toEqual(entry.body);
    expect(JSON.parse(response.out)).toEqual(
      entry.route === "list" ? { items: [routine] } : entry.route === "history" ? history : { item: routine },
    );
    expect(response.out + response.err).not.toContain("fixture-routine-bearer");
  }
});

test("routine inline creation preserves prompt bytes and resolves selected organization and target names", async () => {
  const response = await invoke(
    [
      "create",
      "nightly",
      "--template",
      templateId,
      "--revision",
      "2",
      "--prompt-file",
      "-",
      "--cron",
      config.cron,
      "--timezone",
      config.timezone,
      "--ttl",
      "10m",
      "--max-runs-per-day",
      "2",
      "--json",
    ],
    { selected: "Example", stdin: config.prompt },
  );
  expect(response.code).toBe(0);
  expect(await response.requests[1]!.json()).toEqual({ org, scope: "personal", ...config });
  const named = await invoke(["show", "nightly"]);
  expect(named.code).toBe(0);
  expect(await named.requests[1]!.json()).toEqual({ org, id });
  expect(named.out).toContain(`Template: ${templateId} revision 2`);
  expect(named.out).toContain(config.prompt);
  const explicit = await invoke([
    "create",
    "nightly",
    "--template",
    templateId,
    "--revision",
    "2",
    "--prompt",
    "inspect",
    "--cron",
    config.cron,
    "--timezone",
    config.timezone,
    "--org",
    org,
    "--scope",
    "personal",
    "--json",
  ]);
  expect(explicit.code).toBe(0);
  expect(await explicit.requests[0]!.json()).toEqual({
    org,
    scope: "personal",
    name: "nightly",
    templateId,
    templateRevision: 2,
    prompt: "inspect",
    cron: config.cron,
    timezone: config.timezone,
  });
});

test("routine human output explains history and admitted-run mutation boundaries", async () => {
  const runs = await invoke(["runs", id]);
  expect(runs.code).toBe(0);
  expect(runs.out).toContain("Previous run is still alive.");
  expect(runs.out).toContain("task not observed");
  const pause = await invoke(["pause", id, "--expected-version", "3"], {
    reply: { item: routine, admittedRunsMayFinish: true },
  });
  expect(pause.err).toContain("Already admitted runs may still finish");
  const json = await invoke(["delete", id, "--expected-version", "3", "--json"], {
    reply: { item: routine, admittedRunsMayFinish: true },
  });
  expect(json.err).toBe("");
  expect(JSON.parse(json.out)).toEqual({ item: routine, admittedRunsMayFinish: true });
  expect((await invoke(["list"], { items: [] })).out).toBe("No routines.\n");
  expect((await invoke(["runs", id], { reply: { items: [] } })).out).toBe("No routine runs.\n");
});

test("routine input rejects unsupported mutations and incomplete replacements before network I/O", async () => {
  const valid = [
    "create",
    "nightly",
    "--template",
    templateId,
    "--revision",
    "2",
    "--prompt",
    "inspect",
    "--cron",
    config.cron,
    "--timezone",
    config.timezone,
  ];
  const cases = [
    { args: [...valid, "--org", org] },
    { args: [...valid, "--scope", "other"] },
    { args: [...valid, "--interval-hours", "0"] },
    { args: valid.slice(0, -4) },
    { args: valid.slice(0, -2) },
    { args: [...valid.slice(0, -4), "--timezone", "UTC"] },
    {
      args: ["create", "nightly", "--file", "config.json"],
      file: JSON.stringify({ ...createConfig, cron: undefined }),
    },
    {
      args: ["create", "nightly", "--file", "config.json"],
      file: JSON.stringify({ ...createConfig, timezone: undefined }),
    },
    {
      args: ["create", "nightly", "--file", "config.json"],
      file: JSON.stringify({ ...createConfig, intervalHours: 1 }),
    },
    { args: ["update", id, "--expected-version", "3", "--cron", "0 9 * * *"] },
    { args: ["update", id, "--expected-version", "3", "--cron", "0 9 * * *", "--timezone", "UTC", "--scope", "org"] },
    {
      args: [
        "update",
        id,
        "--expected-version",
        "3",
        "--file",
        "config.json",
        "--cron",
        "0 9 * * *",
        "--timezone",
        "UTC",
      ],
    },
    { args: [...valid, "--max-runs-per-day", "25"] },
    { args: [...valid, "--ttl", "1m"] },
    { args: [...valid, "--prompt-file", "prompt.txt"] },
    { args: [...valid, "--template", templateId] },
    { args: ["create", "nightly", "--file", "config.json"], file: JSON.stringify({ ...createConfig, scope: "org" }) },
    {
      args: ["update", id, "--expected-version", "3", "--file", "config.json"],
      file: JSON.stringify({ ...config, ownerId: id }),
    },
    {
      args: ["update", id, "--expected-version", "3", "--file", "config.json"],
      file: JSON.stringify({ ...config, ttlSeconds: undefined }),
    },
    {
      args: ["update", id, "--expected-version", "3", "--file", "config.json"],
      file: JSON.stringify({ ...config, templateRevision: "2" }),
    },
    { args: ["update", id, "--expected-version", "3"] },
    { args: ["enable", id] },
    { args: ["pause", id, "--expected-version", "0"] },
    { args: ["delete", id, "--expected-version", "3", "--scope", "org"] },
    { args: ["runs", id, "--revision", "1"] },
  ];
  for (const entry of cases) {
    const response = await invoke([...entry.args, "--json"], entry.file === undefined ? {} : { file: entry.file });
    expect(response.code).toBe(2);
    expect(response.requests).toHaveLength(0);
  }
  const unreadable = await invoke(
    ["create", "nightly", "--template", templateId, "--revision", "1", "--prompt-file", "hidden"],
    { readError: true },
  );
  expect(unreadable.code).toBe(2);
  expect(unreadable.err).not.toContain("private file contents");
});

test("routine version conflicts are not retried; ambiguous names never select a resource", async () => {
  const conflict = await invoke(["enable", id, "--expected-version", "3", "--json"], {
    status: 409,
    reply: { error: { code: "conflict", message: "Routine version changed." } },
  });
  expect(conflict.code).toBe(1);
  expect(conflict.requests).toHaveLength(1);
  expect(JSON.parse(conflict.err)).toMatchObject({ error: { code: "conflict" } });
  expect(conflict.err).toContain("--expected-version");
  const failure = await invoke(["pause", id, "--expected-version", "3", "--json"], {
    status: 503,
    reply: { error: { code: "unavailable", message: "do-not-echo private request contents" } },
  });
  expect(failure.code).toBe(1);
  expect(failure.requests).toHaveLength(1);
  expect(failure.err).not.toContain("do-not-echo");
  expect(JSON.parse(failure.err)).toMatchObject({ error: { code: "unavailable" } });
  const ambiguous = await invoke(["show", "nightly"], { items: [routine, { ...routine, id: templateId }] });
  expect(ambiguous.code).toBe(2);
  expect(ambiguous.requests).toHaveLength(1);
  expect(ambiguous.err).toContain("ambiguous");
});

test("routine help is available without authentication or requests", async () => {
  const response = await invoke(["--help"], { token: "" });
  expect(response.code).toBe(0);
  expect(response.requests).toHaveLength(0);
  expect(response.out).toContain("at least ONE HOUR apart");
  expect(response.out).toContain("--expected-version");
});

test("inline schedule updates send a complete owner-neutral replacement with the caller version, without retrying conflicts", async () => {
  const args = ["update", id, "--expected-version", "2", "--cron", "0 10 * * *", "--timezone", "UTC", "--json"];
  const getReply = { item: { ...routine, version: 3, ownerId: "another-owner", scope: "org" } };
  const response = await invoke(args, { getReply });
  expect(response.code).toBe(0);
  expect(response.requests).toHaveLength(2);
  expect(response.requests[0]?.url).toEndWith("/routines/get");
  expect(await response.requests[0]?.json()).toEqual({ org, id });
  expect(response.requests[1]?.url).toEndWith("/routines/update");
  expect(await response.requests[1]?.json()).toEqual({
    org,
    id,
    expectedVersion: 2,
    ...config,
    cron: "0 10 * * *",
    timezone: "UTC",
  });
  const conflict = await invoke(args, {
    getReply,
    status: 409,
    reply: { error: { code: "conflict", message: "Routine version changed." } },
  });
  expect(conflict.code).toBe(1);
  expect(conflict.requests).toHaveLength(2);
  expect(JSON.parse(conflict.err)).toMatchObject({ error: { code: "conflict" } });
});

test("human routine output uses server schedule words and next-run truth, retaining legacy read support", async () => {
  const active = { ...routine, status: "enabled", nextDueAt: "2026-11-13T08:00:00Z" };
  const list = await invoke(["list"], { items: [active, { ...routine, nextDueAt: "stale-must-not-be-shown" }] });
  expect(list.out).toContain(routine.scheduleDescription);
  expect(list.out).toContain("Next: 2026-11-13T08:00:00Z");
  expect(list.out).toContain("Next: none (paused)");
  expect(list.out).not.toContain("stale-must-not-be-shown");
  const show = await invoke(["show", id], { reply: { item: active } });
  expect(show.out).toContain(`Cron: ${config.cron}  Time zone: ${config.timezone}`);
  expect(show.out).toContain("Next: 2026-11-13T08:00:00Z");
  const legacy = await invoke(["list"], {
    items: [{ ...routine, cron: null, timezone: "UTC", scheduleDescription: undefined, intervalHours: 7 }],
  });
  expect(legacy.out).toContain("Every 7 hours (legacy UTC interval)");
});
