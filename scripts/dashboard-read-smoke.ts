/** Read-only SSR smoke. Uses a fresh Supabase user session, never an Armada service bearer. */
interface Io {
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  now: () => number;
  out: (line: string) => void;
}
const AUTH_BOUND_MS = 10_000;
const PAGE_BOUND_MS = 15_000;
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const PAGES = [
  ["sandboxes", "Sandboxes", "/sandboxes"],
  ["routines", "Routines", "/routines"],
  ["templates", "Templates", "/templates"],
  ["otto", "Otto", "/otto"],
  ["environments", "Environments", "/environments"],
  ["skills", "Skills", "/skills"],
  ["tools", "Tools", "/tools"],
  ["variables", "Variables", "/variables"],
  ["models", "Models", "/harness"],
  ["organizations", "Organizations", "/orgs"],
  ["settings", "Settings", "/settings"],
] as const;
class ReadFailure extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}
function fail(code: string): never {
  throw new ReadFailure(code);
}
function origin(value: string | undefined): URL {
  if (!value) fail("invalid_configuration");
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash)
    fail("invalid_configuration");
  return url;
}

/** Whole HTML bodies are consumed: streamed SSR reads must finish before a page can pass. */
export async function dashboardReadSmoke(env: NodeJS.ProcessEnv, io: Io): Promise<boolean> {
  async function step(name: string, bound: number, action: () => Promise<void>) {
    const start = io.now();
    let code: string | undefined;
    try {
      await action();
      if (io.now() - start > bound) fail("read_timeout");
    } catch (error) {
      code =
        error instanceof ReadFailure
          ? error.code
          : error instanceof Error && ["TimeoutError", "AbortError"].includes(error.name)
            ? "read_timeout"
            : "request_failed";
    }
    io.out(
      JSON.stringify({
        case: 0,
        step: `dashboard_${name}`,
        pass: !code,
        bound_ms: bound,
        elapsed_ms: Math.max(0, io.now() - start),
        ...(code ? { code } : {}),
      }),
    );
    return !code;
  }
  let dashboard: URL;
  let auth: URL;
  let org: string;
  let cookie = "";
  const configured = await step("session", AUTH_BOUND_MS, async () => {
    try {
      dashboard = origin(env.ARMADA_SMOKE_DASHBOARD_URL);
      auth = origin(env.ARMADA_SMOKE_SUPABASE_URL);
      org = env.ARMADA_SMOKE_DASHBOARD_ORG_ID ?? "";
      if (
        !UUID.test(org) ||
        !UUID.test(env.ARMADA_SMOKE_DASHBOARD_USER_ID ?? "") ||
        !env.ARMADA_SMOKE_DASHBOARD_EMAIL ||
        !env.ARMADA_SMOKE_DASHBOARD_PASSWORD ||
        !["true", "false"].includes(env.ARMADA_SMOKE_DASHBOARD_OTTO ?? "")
      )
        fail("invalid_configuration");
      const key = env.ARMADA_SMOKE_SUPABASE_ANON_KEY ?? "";
      // Publishable keys or legacy anon JWTs only. A service-role key is not a user session.
      if (!key.startsWith("sb_publishable_")) {
        const claims = JSON.parse(Buffer.from(key.split(".")[1] ?? "", "base64url").toString());
        if (claims.role !== "anon") fail("invalid_configuration");
      }
    } catch {
      fail("invalid_configuration");
    }
    const response = await io.fetch(`${auth.origin}/auth/v1/token?grant_type=password`, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(AUTH_BOUND_MS),
      headers: { apikey: env.ARMADA_SMOKE_SUPABASE_ANON_KEY ?? "", "content-type": "application/json" },
      body: JSON.stringify({ email: env.ARMADA_SMOKE_DASHBOARD_EMAIL, password: env.ARMADA_SMOKE_DASHBOARD_PASSWORD }),
    });
    if (!response.ok) fail("session_failed");
    const session = (await response.json()) as {
      access_token?: unknown;
      refresh_token?: unknown;
      expires_in?: unknown;
      expires_at?: unknown;
      user?: { id?: unknown; role?: unknown };
    };
    if (
      typeof session.access_token !== "string" ||
      typeof session.refresh_token !== "string" ||
      session.user?.id !== env.ARMADA_SMOKE_DASHBOARD_USER_ID ||
      session.user?.role !== "authenticated" ||
      typeof session.expires_in !== "number" ||
      session.expires_in < 60
    )
      fail("invalid_session");
    session.expires_at ??= Math.floor(io.now() / 1000) + session.expires_in;
    // @supabase/ssr 0.12.7's public cookie wire format. The SDK compatibility test
    // decodes this at the real auth boundary, including multi-chunk user metadata.
    const value = `base64-${Buffer.from(JSON.stringify(session)).toString("base64url")}`;
    const name = `sb-${auth.hostname.split(".")[0]}-auth-token`;
    const chunks = value.match(/.{1,3180}/g) ?? [];
    cookie = chunks.map((part, index) => `${name}${chunks.length > 1 ? `.${index}` : ""}=${part}`).join("; ");
    cookie += `; armada-org=${org}`;
  });
  if (!configured) return false;
  const results = await Promise.all(
    PAGES.filter(([name]) => name !== "otto" || env.ARMADA_SMOKE_DASHBOARD_OTTO === "true").map(([name, title, path]) =>
      step(name, PAGE_BOUND_MS, async () => {
        const response = await io.fetch(`${dashboard.origin}${path}`, {
          method: "GET",
          redirect: "manual",
          signal: AbortSignal.timeout(PAGE_BOUND_MS),
          cache: "no-store",
          headers: { cookie, accept: "text/html", "cache-control": "no-cache" },
        });
        if (response.status !== 200)
          fail(response.status >= 300 && response.status < 400 ? "session_or_page_redirect" : "http_failed");
        if (!response.headers.get("content-type")?.includes("text/html")) fail("invalid_html");
        const html = (await response.text()).replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, "");
        // The app shell and exact page heading reject login/landing/error documents.
        if (!/\bdata-shell(?:[\s=>])/.test(html) || !new RegExp(`<h1\\b[^>]*>\\s*${title}\\s*</h1>`, "i").test(html))
          fail("missing_page");
        const selected = html.match(/<select\b[^>]*\bid="active-org"[^>]*>([\s\S]*?)<\/select>/i)?.[1];
        if (!selected?.match(new RegExp(`<option(?=[^>]*\\bvalue="${org}")(?=[^>]*\\bselected(?:=|\\s|>))[^>]*>`, "i")))
          fail("wrong_organization");
        // Errors are often HTTP 200, including streamed panels. Inspect rendered
        // markup, never RSC script strings, arbitrary response text or credentials.
        if (
          /\bdata-dgst=/.test(html) ||
          /<[^>]*\bdata-slot="alert"[^>]*\bclass="[^"]*\btext-destructive\b/i.test(html) ||
          /\bdata-(?:otto-unavailable|catalog-unavailable|template-state="Details unavailable"|setup-state="unavailable"|accounts="(?:error|legacy)"|usage="error")/.test(
            html,
          )
        )
          fail("error_panel");
        const text = html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ");
        if (
          /(?:could not be (?:loaded|read|checked)|Routines are unavailable|Otto is unavailable|The Armada server is (?:not configured|unreachable)|server predates named accounts|Application error:|NEXT_HTTP_ERROR_FALLBACK)/i.test(
            text,
          )
        )
          fail("error_panel");
      }),
    ),
  );
  return results.every(Boolean);
}

if (import.meta.main) {
  const passed = await dashboardReadSmoke(process.env, {
    fetch: (url, init) => fetch(url, init),
    now: Date.now,
    out: (line) => console.log(line),
  });
  if (!passed) process.exitCode = 1;
}
