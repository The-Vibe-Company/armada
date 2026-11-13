/** Bearer-authenticated read probes, not signed-in HTML coverage. */

import { parseDockerHostList } from "../apps/dashboard/src/lib/docker-hosts.ts";
import { dockerLaunchOption } from "../apps/dashboard/src/lib/docker-launch.ts";
import { readOtto } from "../apps/dashboard/src/lib/otto.ts";
import { parseSandboxListMetadata } from "../apps/dashboard/src/lib/sandbox-access.ts";

interface Io {
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  now: () => number;
  out: (line: string) => void;
}
const PAGE_BOUND_MS = 15_000;
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
class ReadFailure extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}
function fail(code: string): never {
  throw new ReadFailure(code);
}

export async function dashboardReadSmoke(env: NodeJS.ProcessEnv, io: Io): Promise<boolean> {
  async function step(name: string, action: () => Promise<void>) {
    const start = io.now();
    let code: string | undefined;
    try {
      await action();
      if (io.now() - start > PAGE_BOUND_MS) fail("read_timeout");
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
        bound_ms: PAGE_BOUND_MS,
        elapsed_ms: Math.max(0, io.now() - start),
        ...(code ? { code } : {}),
      }),
    );
    return !code;
  }
  let serverUrl = "",
    token = "";
  let orgs: string[] = [];
  if (
    !(await step("configuration", async () => {
      try {
        const url = new URL(env.ARMADA_URL ?? "");
        if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash)
          fail("invalid_configuration");
        serverUrl = url.origin;
        token = env.ARMADA_TOKEN ?? "";
        const cases: unknown = JSON.parse(env.ARMADA_SMOKE_CASES ?? "");
        if (!token || !Array.isArray(cases) || !cases.length) fail("invalid_configuration");
        orgs = [...new Set(cases.map((item) => item?.org))];
        if (!orgs.every((org) => typeof org === "string" && UUID.test(org))) fail("invalid_configuration");
      } catch {
        fail("invalid_configuration");
      }
    }))
  )
    return false;
  async function post(route: string, body: object, signal: AbortSignal): Promise<Record<string, unknown>> {
    const response = await io.fetch(`${serverUrl}/api/v1/${route}`, {
      method: "POST",
      redirect: "error",
      cache: "no-store",
      signal,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!response.ok) fail("http_failed");
    const payload: unknown = await response.json();
    signal.throwIfAborted();
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) fail("malformed_read");
    if ("error" in payload) fail("malformed_read");
    return payload as Record<string, unknown>;
  }
  const results = await Promise.all([
    step("sandboxes", async () => {
      const signal = AbortSignal.timeout(PAGE_BOUND_MS);
      for (const org of orgs) {
        for (let page = 1; ; page++) {
          const payload = await post("sandbox/list", { org, page, limit: 200 }, signal);
          if (parseSandboxListMetadata(payload.sandboxes).skipped.length) fail("malformed_read");
          if (typeof payload.hasMore !== "boolean") fail("malformed_read");
          if (!payload.hasMore) break;
          if (page >= 100) fail("incomplete_read");
        }
      }
    }),
    step("otto", async () => {
      const signal = AbortSignal.timeout(PAGE_BOUND_MS);
      for (const orgId of orgs) {
        const result = await readOtto({
          serverUrl,
          token,
          orgId,
          fetch: Object.assign(
            (input: Parameters<typeof fetch>[0], init?: RequestInit) =>
              io.fetch(String(input), {
                ...init,
                signal: init?.signal ? AbortSignal.any([signal, init.signal]) : signal,
              }),
            { preconnect: () => {} },
          ),
        });
        if (result.state !== "ready") fail("otto_read_failed");
        if (result.snapshot.truncated) fail("incomplete_read");
      }
    }),
    step("hosts", async () => {
      const signal = AbortSignal.timeout(PAGE_BOUND_MS);
      for (const org of orgs) {
        const parsed = parseDockerHostList(await post("docker/hosts/list", { org }, signal));
        if (!parsed || parsed.skipped) fail("malformed_read");
      }
    }),
    step("launch_options", async () => {
      const payload = await post("launch/options", {}, AbortSignal.timeout(PAGE_BOUND_MS));
      if (!dockerLaunchOption(payload)) fail("malformed_read");
    }),
  ]);
  return results.every(Boolean);
}
if (import.meta.main) {
  if (
    !(await dashboardReadSmoke(process.env, {
      fetch: (url, init) => fetch(url, init),
      now: Date.now,
      out: (line) => console.log(line),
    }))
  )
    process.exitCode = 1;
}
