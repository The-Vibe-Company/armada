import { describe, expect, test } from "bun:test";
import { NextRequest } from "next/server";
import { captureGitHubAuditLogs } from "../../../scripts/test-support/github-audit.ts";
import { createControlClient } from "../src/lib/control.ts";
import * as gh from "../src/lib/github.ts";
import { proxy } from "../src/proxy.ts";

captureGitHubAuditLogs();

const APP = { clientId: "Iv1.test", clientSecret: "client-secret-value" };
const ACCESS = `ghu_${"0123456789abcdefghijABCDEFGHIJ0123"}`;
const REFRESH = `ghr_${"0123456789abcdefghijABCDEFGHIJ0123"}`;
const ORG_A = { id: 42, account: "octo_emu", account_type: "Organization", repository_selection: "all" } as const;
const ORG_B = { id: 99, account: "acme-inc", account_type: "Organization", repository_selection: "selected" } as const;
const USER_ACC = { id: 7, account: "octocat", account_type: "User", repository_selection: "all" } as const;
const INSTALL_URL = "https://github.com/apps/armada-tvc/installations/new";

const live = (status: gh.LiveGitHubStatus["status"], installations = [ORG_A, ORG_B]) =>
  ({ status, installations: [...installations], installUrl: INSTALL_URL }) satisfies gh.LiveGitHubStatus;

function runConnect(
  sync: () => Promise<gh.LiveGitHubStatus | null>,
  opts: { userId?: number; mode?: "install" | "oauth"; stateVerified?: boolean; revoked?: boolean } = {},
) {
  const userId = opts.userId ?? 583231;
  const mode = opts.mode ?? "install";
  const urls: string[] = [];
  const saved: Parameters<gh.ConnectDeps["save"]>[0][] = [];
  const fetchImpl = (async (input: Parameters<typeof fetch>[0]) => {
    const url = String(input);
    urls.push(url);
    if (url.endsWith("/access_token"))
      return Response.json({ access_token: ACCESS, refresh_token: REFRESH, expires_in: 28_800 });
    if (url.includes("/user/installations")) {
      const account = { login: "acme-inc", type: "Organization" };
      const item = { id: 99, app_id: 7, app_slug: "armada-tvc", account, repository_selection: "selected" };
      return Response.json({ installations: [item] });
    }
    return Response.json({ id: userId, login: userId === 583231 ? "octocat" : "other_user", name: "User" });
  }) as typeof fetch;
  const save: gh.ConnectDeps["save"] = async (c) => {
    saved.push(c);
    return true;
  };
  return gh
    .completeGitHubConnection(
      {
        ownerId: "owner-1",
        app: APP,
        encrypt: async (v) => new TextEncoder().encode(`enc:${v}`),
        save,
        existingConnection: { githubId: 583231, revoked: opts.revoked ?? false },
        syncInstallations: sync,
        fetch: fetchImpl,
      },
      {
        code: "oauth-code",
        redirectUri: "https://armada.test/github/callback",
        mode,
        stateVerified: opts.stateVerified ?? false,
        appIdentity: { slug: "armada-tvc", appId: 7 },
        installationId: mode === "install" ? 99 : null,
      },
    )
    .then((result) => ({ result, saved, urls }));
}

const cb = (setupAction: string | null, installationId: string | null = null, hasSession = true) =>
  gh.decideGitHubCallback({
    error: null,
    stateCookie: undefined,
    stateParam: null,
    code: null,
    setupAction,
    installationId,
    hasSession,
    canVerifyInstallation: true,
  });

describe("multi-org GitHub dashboard UX", () => {
  test("accepts EMU underscore slugs and handles request/update/install callbacks without code", async () => {
    expect(gh.githubInstallUrl("armada_emu")).toBe("https://github.com/apps/armada_emu/installations/new");
    expect(gh.githubInstallUrl("a".repeat(101))).toBeNull();
    expect(gh.githubInstallationManageUrl({ id: 42, account: "octo_emu", accountType: "Organization" })).toBe(
      "https://github.com/organizations/octo_emu/settings/installations/42",
    );
    expect(gh.githubAppIdentityFromEnv({ GITHUB_APP_SLUG: "armada_emu", GITHUB_APP_ID: "7" })).toEqual({
      slug: "armada_emu",
      appId: 7,
    });
    expect(gh.storedGitHubInstallations([ORG_A, { ...ORG_A, id: 43, account: "../bad" }])).toEqual([ORG_A]);
    expect(cb("request")).toEqual({ kind: "result", result: "requested" });
    expect(cb("request", null, false)).toEqual({ kind: "result", result: "sign_in" });
    expect(gh.isGitHubResult("requested") && gh.GITHUB_RESULT_MESSAGES.requested.ok).toBe(true);
    expect(cb("update", "42")).toEqual({ kind: "sync", installationId: 42 });
    expect(cb("install", "99")).toEqual({ kind: "sync", installationId: 99 });
    expect(cb("update", "42", false)).toEqual({ kind: "result", result: "sign_in" });
    expect(await gh.completeGitHubSync(async () => live("connected"))).toBe("synced");
    expect(await gh.completeGitHubSync(async () => live("needs_reconnect", []))).toBe("reconnect_required");
    expect(await gh.completeGitHubSync(async () => live("unavailable", []))).toBe("unavailable");
    expect(await gh.completeGitHubSync(undefined)).toBe("unavailable");
  });

  test("preserves connection_epoch on 2nd-org install, lag and outage; gates cross-identity switch on state", async () => {
    let calls = 0;
    const synced = await runConnect(async () => (++calls === 1 ? live("connected") : live("connected")));
    expect([synced.result, calls, synced.saved.length, synced.urls.length]).toEqual(["synced", 1, 0, 0]);
    let lagCalls = 0;
    const lag = await runConnect(async () => (++lagCalls === 1 ? live("connected", [ORG_A]) : live("connected")));
    expect([lag.result, lagCalls, lag.saved.length]).toEqual(["synced", 2, 0]);
    const outage = await runConnect(async () => null);
    const expired = await runConnect(async () => live("needs_reconnect", []));
    const revoked = await runConnect(async () => live("connected", [ORG_A]), { revoked: true });
    const csrf = await runConnect(async () => live("connected", [ORG_A]), { userId: 777777 });
    const switched = await runConnect(async () => live("connected", [ORG_A]), { userId: 777777, stateVerified: true });
    const explicit = await runConnect(async () => live("connected", [ORG_A]), { mode: "oauth" });
    expect([outage.result, outage.saved.length]).toEqual(["unavailable", 0]);
    expect([expired.result, expired.saved.length]).toEqual(["connected", 1]);
    expect([revoked.result, revoked.saved.length]).toEqual(["connected", 1]);
    expect([csrf.result, csrf.saved.length]).toEqual(["state", 0]);
    expect([switched.result, switched.saved[0]?.user.id]).toEqual(["connected", 777777]);
    expect([explicit.result, explicit.saved.length]).toEqual(["connected", 1]);
  });

  test("syncs github/status over control client, validates installUrl, falls back to DB and pluralizes", async () => {
    const badUrl = "https://evil.example/apps/a/installations/new";
    const bad = gh.parseGitHubStatusResponse({ connection: { ...live("connected"), installUrl: badUrl } });
    expect([bad?.installations, bad?.installUrl]).toEqual([[ORG_A, ORG_B], null]);
    expect(gh.parseGitHubStatusResponse({ connection: { status: "bogus" } })).toBeNull();
    expect(await gh.syncGitHubStatus({ post: async () => Promise.reject(new Error("down")) })).toBeNull();

    let seen = { url: "", auth: null as string | null };
    const fetchControl = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      seen = { url: String(input), auth: new Headers(init?.headers).get("authorization") };
      return Response.json({ connection: live("connected") });
    }) as typeof fetch;
    const ctrl = createControlClient({
      serverUrl: "https://api.armada.test",
      token: "viewer-jwt",
      fetch: fetchControl,
    });
    expect((await gh.syncGitHubStatus(ctrl))?.installations).toEqual([ORG_A, ORG_B]);
    expect(seen).toEqual({ url: "https://api.armada.test/api/v1/github/status", auth: "Bearer viewer-jwt" });
    expect(typeof proxy).toBe("function");
    expect(new NextRequest("https://armada.test/api/github/sync", { method: "POST" }).nextUrl.pathname).toBe(
      "/api/github/sync",
    );

    const db = { revoked_at: null, installations: [ORG_A] };
    const view = (s: gh.LiveGitHubStatus | null, conn: typeof db | null = db) =>
      gh.resolveSettingsGitHubView({ dbConnection: conn, liveStatus: s, serverConfigured: true, envInstallUrl: null });
    const connected = view(live("connected"));
    expect([connected.state, connected.installations, connected.installUrl, connected.liveSync]).toEqual([
      "connected",
      [ORG_A, ORG_B],
      INSTALL_URL,
      "live",
    ]);
    expect(view(null)).toEqual({ state: "connected", installations: [ORG_A], installUrl: null, liveSync: "fallback" });
    expect(view(live("unavailable", []), null).liveSync).toBe("fallback");
    expect(view(live("needs_reconnect", [])).state).toBe("revoked");
    expect(gh.githubInstallationsSummary([])).toBe("No GitHub organizations or accounts connected yet.");
    expect(gh.githubInstallationsSummary([USER_ACC])).toBe("Connected to 1 personal account.");
    expect(gh.githubInstallationsSummary([ORG_A])).toBe("Connected to 1 GitHub organization.");
    expect(gh.githubInstallationsSummary([ORG_A, ORG_B])).toBe("Connected to 2 GitHub organizations.");
    expect(gh.githubInstallationsSummary([ORG_A, ORG_B, USER_ACC])).toBe(
      "Connected to 2 GitHub organizations and 1 personal account.",
    );
  });
});
