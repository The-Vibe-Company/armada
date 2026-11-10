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

test.each(["resume", "recover"])(
  "registered %s sends exact candidate route, org selector, key and revision without prompt",
  async (action) => {
    const response = { ...receipt, kind: action === "recover" ? "stop" : "resume" };
    const h = harness(() => Response.json(response, { status: 202 }));
    expect(
      await h.invoke([
        action,
        "parent-1",
        "--org",
        "org-1",
        "--expected-revision",
        "7",
        "--idempotency-key",
        "same-key",
        "--json",
      ]),
    ).toEqual({ code: 0, out: `${JSON.stringify(response)}\n`, err: "" });
    expect(h.requests).toHaveLength(1);
    const request = h.requests[0] as Request;
    expect([
      request.method,
      request.url,
      request.headers.get("idempotency-key"),
      request.headers.get("authorization"),
    ]).toEqual([
      "POST",
      `https://armada.test/api/v1/orchestrators/parent-1/${action}`,
      "same-key",
      "Bearer test-armada-bearer",
    ]);
    expect(await request.json()).toEqual({ orgId: "org-1", expectedRevision: 7 });
  },
);

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

test("create forwards only an explicit canonical size, leaving absent size and child limits to server policy", async () => {
  const create = [
    "create",
    "coordinator",
    "--org",
    "org-1",
    "--golden",
    "golden-1",
    "--provider",
    "boat",
    "--agent",
    "claude",
    "--model",
    "model-1",
    "--model-account",
    "account-1",
    "--repo",
    "web",
    "--idempotency-key",
    "create-key",
    "--json",
  ];
  for (const size of [undefined, "small", "medium", "large", "xlarge"]) {
    const h = harness(() => Response.json({ ...receipt, kind: "create" }, { status: 202 }));
    expect((await h.invoke([...create, ...(size ? ["--size", size] : [])])).code).toBe(0);
    const body = await h.requests[0]?.json();
    expect(body).toEqual({
      version: 1,
      orgId: "org-1",
      name: "coordinator",
      goldenId: "golden-1",
      provider: "boat",
      harness: "claude",
      model: "model-1",
      modelAccountId: "account-1",
      repo: "web",
      ...(size ? { size } : {}),
    });
  }
  for (const size of ["default", "huge"]) {
    const h = harness(() => {
      throw new Error("must not transport invalid size");
    });
    expect((await h.invoke([...create, "--size", size])).code).toBe(2);
    expect(h.requests).toHaveLength(0);
  }
});

test("unstructured HTTP failures identify the actual origin without relaying upstream text", async () => {
  for (const body of ["private-upstream-html", JSON.stringify({ error: "private-upstream-diagnostic" })]) {
    const h = harness(() => new Response(body, { status: 404 }));
    const result = await h.invoke([
      "recover",
      "parent-1",
      "--org",
      "org-1",
      "--expected-revision",
      "1",
      "--idempotency-key",
      "same-key",
      "--json",
    ]);
    expect(result.code).toBe(1);
    expect(JSON.parse(result.err)).toEqual({
      error: { code: "unavailable", message: "Armada server request failed (404) at https://armada.test." },
    });
    expect(result.err).not.toContain("private-upstream");
    expect(result.err).not.toContain("test-armada-bearer");
  }
});

// Transport boundary: a lost synchronous stop response must not invite a second stop.
test("stop transport loss gives reconciliation instructions and never retries", async () => {
  const h = harness(() => {
    throw new Error("transport lost");
  });
  const result = await h.invoke([
    "stop",
    "parent-1",
    "--org",
    "org-1",
    "--expected-revision",
    "7",
    "--idempotency-key",
    "same-key",
    "--json",
  ]);
  expect(result.code).toBe(1);
  expect(JSON.parse(result.err).error.message).toContain("armada orchestrator detail parent-1 --org org-1");
  expect(JSON.parse(result.err).error.message).toContain("same idempotency key");
  expect(h.requests).toHaveLength(1);
});
