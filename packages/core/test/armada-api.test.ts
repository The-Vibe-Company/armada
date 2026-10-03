import { expect, test } from "bun:test";
import {
  ArmadaApiError,
  armadaApi,
  compareVersions,
  newerRelease,
  releaseLine,
  type ServerCli,
  waitForApproval,
} from "../src/armada-api.ts";
import { ARMADA_URL, fakeArmada, NOW } from "./support.ts";

/** A clock that moves only when the code sleeps. */
function clock() {
  let t = NOW.getTime();
  const slept: number[] = [];
  return {
    slept,
    now: () => new Date(t),
    sleep: async (ms: number) => {
      slept.push(ms);
      t += ms;
    },
  };
}

test("login polls at the server's interval, 5 s slower at each slow_down, until the person approves", async () => {
  const armada = fakeArmada({ polls: ["pending", "slow_down", "pending", "approve"] });
  const api = armadaApi({ url: ARMADA_URL, fetch: armada.fetch });
  const code = await api.startDeviceLogin();
  expect(code).toMatchObject({ userCode: "WDJBMJHT", intervalSeconds: 5, expiresInSeconds: 900 });
  const c = clock();
  expect(await waitForApproval({ api, code, ...c })).toBe("session-token-1");
  expect(c.slept).toEqual([5000, 5000, 10000, 10000]);
});

test("a denied or expired code ends the wait with armada login as the next step; the network going away only slows it", async () => {
  const api = (polls: string[]) => armadaApi({ url: ARMADA_URL, fetch: fakeArmada({ polls }).fetch });
  const code = await api([]).startDeviceLogin();
  const failure = (work: Promise<unknown>) =>
    work.then(
      () => null,
      (err: ArmadaApiError) => [err.message, err.next],
    );
  expect(await failure(waitForApproval({ api: api(["access_denied"]), code, ...clock() }))).toEqual([
    "the sign-in was denied in the browser",
    "armada login",
  ]);
  // Nobody approves: the code runs out on the clock.
  const c = clock();
  const forever = { pollDeviceLogin: async () => ({ state: "pending" as const }) };
  expect(await failure(waitForApproval({ api: forever, code, ...c }))).toEqual([
    "the code expired before it was approved",
    "armada login",
  ]);
  expect(c.slept.reduce((a, b) => a + b, 0)).toBeGreaterThan(900_000);

  let calls = 0;
  const flaky = {
    pollDeviceLogin: async () => {
      if (++calls < 3) throw new ArmadaApiError("Armada (armada.example.test) unreachable: no answer within 30 s");
      return { state: "approved" as const, token: "t" };
    },
  };
  const f = clock();
  expect(await waitForApproval({ api: flaky, code, ...f })).toBe("t");
  expect(f.slept).toEqual([5000, 10000, 20000]);
});

test("a revoked credential is signed out with the server's next step; an address that is not an Armada says so", async () => {
  const api = armadaApi({ url: ARMADA_URL, fetch: fakeArmada().fetch });
  const revoked = await api.whoami({ kind: "api-key", key: "armada_revoked" }).catch((err: ArmadaApiError) => err);
  expect(revoked).toBeInstanceOf(ArmadaApiError);
  expect(revoked).toMatchObject({ signedOut: true, next: "armada login" });

  const html = armadaApi({ url: "https://example.test/armada", fetch: async () => new Response("<html>") });
  const err = await html.startDeviceLogin().catch((e: ArmadaApiError) => e);
  expect((err as ArmadaApiError).message).toContain("without JSON: is https://example.test an Armada?");
  // A self-hosted Armada under a path keeps it.
  const seen: string[] = [];
  const under = armadaApi({
    url: "https://example.test/armada",
    fetch: async (url) => {
      seen.push(url);
      return Response.json({ error: "x" }, { status: 401 });
    },
  });
  await under.whoami({ kind: "session", token: "t" }).catch(() => {});
  expect(seen).toEqual(["https://example.test/armada/api/cli/session"]);
  expect(() => armadaApi({ url: "ftp://example.test" })).toThrow("http or https");
  // Plain http carries tokens in the clear: only to this machine.
  expect(() => armadaApi({ url: "http://armada.example.test" })).toThrow("must use https");
  expect(() => armadaApi({ url: "http://localhost:4822" })).not.toThrow();
});

test("specific launch cleanup never falls back to ticket-wide revocation on an older server", async () => {
  const seen: string[] = [];
  const api = armadaApi({
    url: ARMADA_URL,
    fetch: async (url) => {
      seen.push(url);
      return Response.json({ error: "unknown route" }, { status: 404 });
    },
  });
  await expect(
    api.revokePendingLaunch(
      { kind: "session", token: "synthetic-session" },
      { project: "widgets", ticket: "WID-83", id: "synthetic-launch-id" },
    ),
  ).rejects.toBeInstanceOf(ArmadaApiError);
  expect(seen).toEqual([`${ARMADA_URL}/api/cli/workers/revoke-pending`]);
});

test("a CLI older than the server expects gets one upgrade line instead of an answer it cannot read", async () => {
  const armada = fakeArmada({ cli: { minimum: "0.2.0", latest: "0.2.5" } });
  const signIn = { kind: "session" as const, token: "t" };
  const old = armadaApi({ url: ARMADA_URL, fetch: armada.fetch, version: "0.1.22" });
  const err = await old.whoami(signIn).catch((e: ArmadaApiError) => e);
  expect(err).toBeInstanceOf(ArmadaApiError);
  expect(err).toMatchObject({
    message: "Armada 0.1.22 is older than this server expects: npm install -g @the-vibe-company/armada@0.2.5",
    upgrade: "0.2.5",
    signedOut: false,
  });
  expect(armada.calls.at(-1)?.version).toBe("0.1.22");

  // Current, or talking to a server that names no minimum: answers as before.
  const heard: ServerCli[] = [];
  const current = armadaApi({
    url: ARMADA_URL,
    fetch: armada.fetch,
    version: "0.2.0",
    onServerCli: (s) => heard.push(s),
  });
  expect(await current.startDeviceLogin()).toMatchObject({ userCode: "WDJBMJHT" });
  expect(current.serverCli()).toEqual({ minimum: "0.2.0", latest: "0.2.5" });
  expect(heard).toEqual([{ minimum: "0.2.0", latest: "0.2.5" }]);
  const older = armadaApi({ url: ARMADA_URL, fetch: fakeArmada().fetch, version: "0.1.22" });
  expect(await older.startDeviceLogin()).toMatchObject({ userCode: "WDJBMJHT" });
  expect(older.serverCli()).toBeNull();
});

test("a newer release is named with its install command, the skills step and its notes", () => {
  expect(newerRelease("0.2.3", "0.2.4")).toBe("0.2.4");
  expect(newerRelease("0.2.4", "0.2.4")).toBeNull();
  expect(newerRelease("0.2.5", "0.2.4")).toBeNull();
  expect(newerRelease("0.2.3", null)).toBeNull();
  // A development build is never told to install a release.
  expect(newerRelease("0.0.0", "0.2.4")).toBeNull();
  expect(releaseLine("0.2.3", "0.2.4")).toBe(
    "Armada 0.2.4 is out (you run 0.2.3): npm install -g @the-vibe-company/armada@0.2.4 — then armada init to refresh this project's skills. Changes: https://github.com/The-Vibe-Company/armada/releases/tag/v0.2.4",
  );
});

test("versions compare by number", () => {
  expect(compareVersions("0.1.22", "0.2.0")).toBe(-1);
  expect(compareVersions("0.10.0", "0.9.9")).toBe(1);
  expect(compareVersions("1.2.3-beta.1", "1.2.3")).toBe(0);
});
