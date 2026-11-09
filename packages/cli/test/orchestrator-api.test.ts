import { expect, test } from "bun:test";
import { run } from "../src/run.ts";
import { memorySessionStore } from "../src/session.ts";

function harness(respond: (request: Request) => Response | Promise<Response>, sleep?: () => Promise<void>) {
  let out = "";
  let err = "";
  const requests: Request[] = [];
  const auth = {
    env: { ARMADA_TOKEN: "test-armada-bearer", ARMADA_URL: "https://armada.test" },
    session: memorySessionStore(),
    now: () => new Date(),
    open: () => {},
    out: (text: string) => {
      out += text;
    },
    err: (text: string) => {
      err += text;
    },
    fetch: async (input: string | URL | Request, init?: RequestInit) => {
      const request =
        typeof input === "string" || input instanceof URL ? new Request(String(input), init) : new Request(input, init);
      requests.push(request);
      return respond(request);
    },
  };
  return {
    requests,
    async invoke(args: string[]) {
      const code = await run(["orchestrator", ...args], auth, { auth, ...(sleep ? { sleep } : {}) });
      return { code, out, err };
    },
  };
}

const receipt = {
  version: 1,
  id: "op-1",
  orchestratorId: "parent-1",
  kind: "resume",
  state: "pending",
  revision: 8,
  errorCode: null,
};

test("registered resume sends exact candidate route, org selector, key and revision without prompt", async () => {
  const h = harness(() => Response.json(receipt, { status: 202 }));
  expect(
    await h.invoke([
      "resume",
      "parent-1",
      "--org",
      "org-1",
      "--expected-revision",
      "7",
      "--idempotency-key",
      "same-key",
      "--json",
    ]),
  ).toEqual({ code: 0, out: `${JSON.stringify(receipt)}\n`, err: "" });
  expect(h.requests).toHaveLength(1);
  const request = h.requests[0] as Request;
  expect([
    request.method,
    request.url,
    request.headers.get("idempotency-key"),
    request.headers.get("authorization"),
  ]).toEqual([
    "POST",
    "https://armada.test/api/v1/orchestrators/parent-1/resume",
    "same-key",
    "Bearer test-armada-bearer",
  ]);
  expect(await request.json()).toEqual({ orgId: "org-1", expectedRevision: 7 });
});

test("rejects keys that HTTP headers would trim before making any request", async () => {
  const h = harness(() => {
    throw new Error("Must not reach transport");
  });
  const result = await h.invoke([
    "resume",
    "parent-1",
    "--org",
    "org-1",
    "--expected-revision",
    "7",
    "--idempotency-key",
    " same-key ",
    "--json",
  ]);
  expect(result.code).toBe(2);
  expect(JSON.parse(result.err).error.code).toBe("usage");
  expect(h.requests).toHaveLength(0);
});

test("server conflict is machine-readable and never causes a new mutation or revision retry", async () => {
  const h = harness(() => Response.json({ error: { code: "conflict", message: "conflict" } }, { status: 409 }));
  expect(
    await h.invoke([
      "stop",
      "parent-1",
      "--org",
      "org-1",
      "--expected-revision",
      "7",
      "--idempotency-key",
      "same-key",
      "--json",
    ]),
  ).toEqual({ code: 1, out: "", err: '{"error":{"code":"conflict","message":"conflict"}}\n' });
  expect(h.requests).toHaveLength(1);
});

test("capabilities truthfully expose disabled candidate runtime; help needs no login", async () => {
  const h = harness(() => Response.json({ version: 1, enabled: false, reason: "native_conformance_required" }));
  expect(await h.invoke(["capabilities", "--json"])).toEqual({
    code: 0,
    out: '{"version":1,"enabled":false,"reason":"native_conformance_required"}\n',
    err: "",
  });
  expect(h.requests[0]?.url).toBe("https://armada.test/api/v1/orchestrators/capabilities");
  let text = "";
  expect(
    await run(
      ["orchestrator", "--help"],
      {
        out: (s) => {
          text += s;
        },
        err: () => {},
      },
      { env: {} },
    ),
  ).toBe(0);
  expect(text).toContain("--expected-revision");
});

test("event drain preserves unknown events and server cursor in NDJSON, then reconnects from delivered cursor", async () => {
  const unknown = { id: "event-1", kind: "future_kind", data: "preserved" };
  const pages = [
    { version: 1, events: [unknown], cursor: "opaque+/=", hasMore: true },
    { version: 1, events: [], cursor: "next", hasMore: false },
  ];
  const h = harness(() => Response.json(pages.shift()));
  const result = await h.invoke(["events", "parent-1", "--org", "org-1", "--cursor", "before", "--all", "--json"]);
  expect(result.code).toBe(0);
  expect(result.err).toBe("");
  expect(
    result.out
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line)),
  ).toEqual([
    { version: 1, events: [unknown], cursor: "opaque+/=", hasMore: true },
    { version: 1, events: [], cursor: "next", hasMore: false },
  ]);
  expect(new URL((h.requests[1] as Request).url).searchParams.get("cursor")).toBe("opaque+/=");
});

test("follow waits only after drained pages and a failed poll retains the last delivered cursor", async () => {
  let calls = 0;
  let sleeps = 0;
  const h = harness(
    () =>
      ++calls === 1
        ? Response.json({ version: 1, events: [], cursor: "saved", hasMore: false })
        : Response.json({ error: { code: "unavailable", message: "unavailable" } }, { status: 503 }),
    async () => {
      sleeps++;
    },
  );
  expect(await h.invoke(["events", "id", "--org", "org", "--follow", "--json"])).toEqual({
    code: 1,
    out: '{"version":1,"events":[],"cursor":"saved","hasMore":false}\n',
    err: '{"error":{"code":"unavailable","message":"unavailable"}}\n',
  });
  expect(sleeps).toBe(1);
  expect(new URL((h.requests[1] as Request).url).searchParams.get("cursor")).toBe("saved");
});

test("bad version or nonadvancing drain cursor fails rather than silently looping", async () => {
  for (const page of [
    { version: 2, events: [], cursor: "new", hasMore: false },
    { version: 1, events: [], cursor: "same", hasMore: true },
  ]) {
    const h = harness(() => Response.json(page));
    const result = await h.invoke(["events", "id", "--org", "org", "--cursor", "same", "--all", "--json"]);
    expect(result.code).toBe(1);
    expect(JSON.parse(result.err).error.code).toBe("unavailable");
    expect(h.requests).toHaveLength(1);
  }
});
