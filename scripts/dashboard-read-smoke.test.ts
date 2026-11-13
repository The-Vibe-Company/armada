import { expect, test } from "bun:test";
import { createRequire } from "node:module";
import { dashboardReadSmoke } from "./dashboard-read-smoke.ts";

const USER = "00000000-0000-4000-8000-000000000001";
const ORG = "00000000-0000-4000-8000-000000000010";
const env = {
  ARMADA_SMOKE_DASHBOARD_URL: "https://dashboard.example.test",
  ARMADA_SMOKE_SUPABASE_URL: "https://project.supabase.co",
  ARMADA_SMOKE_SUPABASE_ANON_KEY: "sb_publishable_test",
  ARMADA_SMOKE_DASHBOARD_EMAIL: "smoke@example.test",
  ARMADA_SMOKE_DASHBOARD_PASSWORD: "test-only-password",
  ARMADA_SMOKE_DASHBOARD_USER_ID: USER,
  ARMADA_SMOKE_DASHBOARD_ORG_ID: ORG,
  ARMADA_SMOKE_DASHBOARD_OTTO: "true",
};
const titles: Record<string, string> = {
  "/sandboxes": "Sandboxes",
  "/routines": "Routines",
  "/templates": "Templates",
  "/otto": "Otto",
  "/environments": "Environments",
  "/skills": "Skills",
  "/tools": "Tools",
  "/variables": "Variables",
  "/harness": "Models",
  "/orgs": "Organizations",
  "/settings": "Settings",
};
const session = {
  access_token: "test-only-user-access",
  refresh_token: "test-only-refresh",
  expires_in: 3600,
  expires_at: 4_000_000_000,
  user: { id: USER, role: "authenticated", user_metadata: { description: "a".repeat(5000) } },
};
function html(path: string, content = "") {
  return `<div data-shell="true"><select id="active-org"><option value="${ORG}" selected="">Smoke</option></select><main><h1>${titles[path]}</h1>${content}</main></div>`;
}
function document(body: string, status = 200) {
  return new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8" } });
}

// Authoring gate: the real SDK decoding protects cookie interoperability, fake
// HTTP responses protect named verdicts, parallel admission and secret-free output.
// Existing compute smoke tests cannot reach the dashboard's cookie/SSR boundary.
test("fresh user cookies work with the dashboard SDK; every SSR read starts before any finishes", async () => {
  const requests: { path: string; init: RequestInit; resolve: (response: Response) => void }[] = [];
  const lines: string[] = [];
  let allStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    allStarted = resolve;
  });
  const run = dashboardReadSmoke(env, {
    now: () => 0,
    out: (line) => lines.push(line),
    fetch: async (url, init) => {
      if (url.includes("/auth/v1/token")) {
        expect(JSON.parse(String(init.body))).toEqual({
          email: env.ARMADA_SMOKE_DASHBOARD_EMAIL,
          password: env.ARMADA_SMOKE_DASHBOARD_PASSWORD,
        });
        return Response.json(session);
      }
      return new Promise<Response>((resolve) => {
        requests.push({ path: new URL(url).pathname, init, resolve });
        if (requests.length === 11) allStarted();
      });
    },
  });
  await started;
  expect(requests.map(({ path }) => path).sort()).toEqual(Object.keys(titles).sort());
  const cookie = new Headers(requests[0]?.init.headers).get("cookie") ?? "";
  // Load the dashboard's pinned dependency, not an independently maintained decoder.
  const require = createRequire(new URL("../apps/dashboard/package.json", import.meta.url));
  const { createServerClient } = require("@supabase/ssr");
  const client = createServerClient(env.ARMADA_SMOKE_SUPABASE_URL, env.ARMADA_SMOKE_SUPABASE_ANON_KEY, {
    cookies: {
      getAll: () =>
        cookie.split("; ").map((part) => {
          const [name, ...value] = part.split("=");
          return { name, value: value.join("=") };
        }),
      setAll: () => {},
    },
    global: {
      fetch: () => {
        throw new Error("SDK session read must stay offline");
      },
    },
  });
  const { data, error } = await client.auth.getSession();
  expect(error).toBeNull();
  expect(data.session.access_token).toBe(session.access_token);
  expect(data.session.user.id).toBe(USER);
  for (const { path, init, resolve } of requests) {
    expect(new Headers(init.headers).has("authorization")).toBe(false);
    expect(init.redirect).toBe("manual");
    expect(init.signal).toBeInstanceOf(AbortSignal);
    resolve(document(html(path, '<script>"Otto is unavailable"</script>')));
  }
  expect(await run).toBe(true);
  expect(lines.map((line) => JSON.parse(line).step)).toContain("dashboard_models");
  expect(lines.join(" ")).not.toContain(session.refresh_token);
  expect(lines.join(" ")).not.toContain(env.ARMADA_SMOKE_DASHBOARD_PASSWORD);
});

test.each([
  [
    "destructive HTTP 200",
    () =>
      document(
        html(
          "/otto",
          '<div data-slot="alert" role="alert" class="bg-card text-destructive"><div>The server is unreachable.</div></div>',
        ),
      ),
    "error_panel",
  ],
  [
    "plain unavailable HTTP 200",
    () => document(html("/otto", '<div data-otto-unavailable="true">Otto is unavailable</div>')),
    "error_panel",
  ],
  [
    "nested read failure HTTP 200",
    () => document(html("/otto", "<p>Some template revisions could not be read.</p>")),
    "error_panel",
  ],
  [
    "streamed SSR exception",
    () => document(html("/otto", '<template data-dgst="server-error"></template>')),
    "error_panel",
  ],
  [
    "login redirect",
    () => new Response(null, { status: 307, headers: { location: "https://other.example/login" } }),
    "session_or_page_redirect",
  ],
  ["server failure", () => document("server failure", 500), "http_failed"],
  ["wrong document", () => document("<h1>Sign in</h1>"), "missing_page"],
  ["wrong org", () => document(html("/otto").replace(`value="${ORG}"`, 'value="other"')), "wrong_organization"],
  [
    "timeout",
    () => {
      throw new DOMException("not logged", "TimeoutError");
    },
    "read_timeout",
  ],
] as const)("%s fails its named step without hiding sibling results", async (_name, response, code) => {
  const lines: { step: string; pass: boolean; code?: string }[] = [];
  const passed = await dashboardReadSmoke(env, {
    now: () => 0,
    out: (line) => lines.push(JSON.parse(line)),
    fetch: async (url) =>
      url.includes("/auth/v1/token")
        ? Response.json(session)
        : new URL(url).pathname === "/otto"
          ? response()
          : document(html(new URL(url).pathname)),
  });
  expect(passed).toBe(false);
  expect(lines.filter((line) => !line.pass)).toEqual([expect.objectContaining({ step: "dashboard_otto", code })]);
  expect(lines.filter((line) => line.pass)).toHaveLength(11);
});

// These read failures live in normal SSR row/catalog markup, not destructive
// alerts. Template details are a client portal and need not exist in this HTML.
test.each([
  [
    "/tools",
    "dashboard_tools",
    '<section><p class="text-muted-foreground" data-catalog-unavailable="true">Services are not available: Request failed. You can still add a custom server.</p></section>',
  ],
  [
    "/templates",
    "dashboard_templates",
    '<div data-template="Smoke"><span class="inline-flex text-muted-foreground" data-template-state="Details unavailable"><span class="truncate">Details unavailable</span></span></div>',
  ],
] as const)("%s fails its named step on a non-alert SSR read failure", async (path, step, markup) => {
  const lines: { step: string; pass: boolean; code?: string }[] = [];
  expect(
    await dashboardReadSmoke(env, {
      now: () => 0,
      out: (line) => lines.push(JSON.parse(line)),
      fetch: async (url) => {
        if (url.includes("/auth/v1/token")) return Response.json(session);
        const requested = new URL(url).pathname;
        return document(html(requested, requested === path ? markup : ""));
      },
    }),
  ).toBe(false);
  expect(lines.filter((line) => !line.pass)).toEqual([expect.objectContaining({ step, code: "error_panel" })]);
  expect(lines.filter((line) => line.pass)).toHaveLength(11);
});

test("Otto is explicitly optional and slow completed bodies still fail the bound", async () => {
  let now = 0;
  const lines: { step: string; pass: boolean; code?: string }[] = [];
  const paths: string[] = [];
  expect(
    await dashboardReadSmoke(
      { ...env, ARMADA_SMOKE_DASHBOARD_OTTO: "false" },
      {
        now: () => now,
        out: (line) => lines.push(JSON.parse(line)),
        fetch: async (url) => {
          if (url.includes("/auth/v1/token")) return Response.json(session);
          const path = new URL(url).pathname;
          paths.push(path);
          const response = document(html(path));
          if (path === "/settings")
            Object.defineProperty(response, "text", {
              value: async () => {
                now = 15_001;
                return html(path);
              },
            });
          return response;
        },
      },
    ),
  ).toBe(false);
  expect(paths).not.toContain("/otto");
  expect(lines).toContainEqual(
    expect.objectContaining({ step: "dashboard_settings", pass: false, code: "read_timeout" }),
  );
});

test.each<NodeJS.ProcessEnv>([
  { ...env, ARMADA_SMOKE_DASHBOARD_URL: "https://dashboard.example.test/path" },
  { ...env, ARMADA_SMOKE_DASHBOARD_PASSWORD: "" },
  { ...env, ARMADA_SMOKE_DASHBOARD_OTTO: "" },
  {
    ...env,
    ARMADA_SMOKE_SUPABASE_ANON_KEY: `x.${Buffer.from(JSON.stringify({ role: "service_role" })).toString("base64url")}.x`,
  },
])("invalid session configuration makes no requests", async (config) => {
  let requests = 0;
  expect(
    await dashboardReadSmoke(config, {
      now: () => 0,
      out: () => {},
      fetch: async () => {
        requests++;
        throw new Error("must not reach network");
      },
    }),
  ).toBe(false);
  expect(requests).toBe(0);
});

test("a different authenticated user never reaches dashboard reads", async () => {
  const lines: string[] = [];
  let requests = 0;
  expect(
    await dashboardReadSmoke(env, {
      now: () => 0,
      out: (line) => lines.push(line),
      fetch: async () => {
        requests++;
        return Response.json({ ...session, user: { ...session.user, id: ORG } });
      },
    }),
  ).toBe(false);
  expect(requests).toBe(1);
  expect(JSON.parse(lines[0] ?? "")).toMatchObject({ step: "dashboard_session", code: "invalid_session" });
});
