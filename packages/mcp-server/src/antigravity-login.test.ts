import { expect, test } from "bun:test";
import { type AntigravityLoginProcess, createAntigravityLogin } from "./antigravity-login.ts";

const caller = { userId: "alice", orgId: "personal" };
const target = { id: "account", expectedVersion: 2 };
const authorization = new URL("https://accounts.google.com/o/oauth2/v2/auth");
authorization.search = new URLSearchParams({
  redirect_uri: "https://antigravity.google/oauth-callback",
  state: "matching",
}).toString();

function fixture(
  link = authorization.href,
  token: unknown = { access_token: "access", refresh_token: "refresh" },
  onClose?: () => Promise<void>,
) {
  const deadline = new AbortController();
  const { promise: exited, resolve: exit } = Promise.withResolvers<number>();
  const submitted: string[] = [];
  let closes = 0;
  const child: AntigravityLoginProcess = {
    authorizationUrl: Promise.resolve(link),
    exited,
    async submitCode(code) {
      submitted.push(code);
    },
    async readToken() {
      return token;
    },
    async close() {
      await onClose?.();
      closes++;
      exit(1);
    },
  };
  const login = createAntigravityLogin(async () => child, { now: () => 0, deadline: () => deadline.signal });
  return { login, deadline, submitted, exit, closes: () => closes };
}

test.each([
  authorization.href.replace("accounts.google.com", "accounts.example.com"),
  authorization.href.replace("antigravity.google", "example.com"),
  authorization.href.replace("/o/oauth2/v2/auth", "/untrusted"),
  `${authorization.href}&state=duplicate`,
])("refuses untrusted authorization links and closes the process", async (link) => {
  const { login, closes } = fixture(link);
  await expect(login.start(caller, target)).rejects.toThrow("Antigravity sign-in failed.");
  expect(closes()).toBe(1);
});

test("invalid codes never reach stdin and leave the pending login usable", async () => {
  const { login, submitted } = fixture();
  const { loginId } = await login.start(caller, target);
  for (const invalid of [
    "code\n",
    "a".repeat(2049),
    "https://antigravity.google/oauth-callback?code=example%0A&state=matching",
  ]) {
    await expect(login.complete(caller, loginId, invalid)).rejects.toThrow("matching Google sign-in");
  }
  await expect(
    login.complete(caller, loginId, "https://antigravity.google/oauth-callback?code=example&state=foreign"),
  ).rejects.toThrow("Start sign-in again.");
  expect(submitted).toEqual([]);
  await login.cancel(caller, loginId);
});

test("binds a single claim to the initiating user, org and account version", async () => {
  const { login, submitted, exit, closes } = fixture();
  const start = await login.start(caller, target);
  expect(start).toEqual({
    loginId: expect.any(String),
    authorizationUrl: authorization.href,
    expiresAt: "1970-01-01T00:05:00.000Z",
  });
  await expect(login.start(caller, target)).rejects.toThrow("already pending");
  await expect(login.complete({ ...caller, userId: "other" }, start.loginId, "code")).rejects.toThrow(
    "Start sign-in again",
  );
  await expect(login.complete({ ...caller, orgId: "other" }, start.loginId, "code")).rejects.toThrow(
    "Start sign-in again",
  );
  const complete = login.complete(
    caller,
    start.loginId,
    "https://antigravity.google/oauth-callback?code=example%2Fcode&state=matching",
  );
  await expect(login.complete(caller, start.loginId, "code")).rejects.toThrow("Start sign-in again");
  exit(0);
  expect(await complete).toEqual({
    target,
    credential: { method: "google", token: { access_token: "access", refresh_token: "refresh" } },
  });
  expect(submitted).toEqual(["example/code"]);
  expect(closes()).toBe(1);
  await expect(login.complete(caller, start.loginId, "code")).rejects.toThrow("Start sign-in again");
});

test("completes Google sign-in with the native OAuth2 token metadata", async () => {
  const token = { access_token: "access", refresh_token: "refresh", token_type: "Bearer", expires_in: 3599 };
  const { login, exit } = fixture(authorization.href, token);
  const { loginId } = await login.start(caller, target);
  const complete = login.complete(caller, loginId, "example");
  exit(0);
  expect(await complete).toEqual({ target, credential: { method: "google", token } });
});

test("the deadline closes a pending exchange and refuses the result", async () => {
  const { login, submitted, closes, deadline } = fixture();
  const { loginId } = await login.start(caller, target);
  const complete = login.complete(caller, loginId, "example");
  await Promise.resolve();
  expect(submitted).toEqual(["example"]);
  deadline.abort();
  await expect(complete).rejects.toThrow("Start sign-in again.");
  expect(closes()).toBe(1);
});

test("invalid token details never appear in an error", async () => {
  const { login, exit, closes } = fixture(authorization.href, { access_token: "private value" });
  const { loginId } = await login.start(caller, target);
  const complete = login.complete(caller, loginId, "example");
  exit(0);
  await expect(complete).rejects.toThrow(/^Antigravity sign-in failed\. Start sign-in again\.$/);
  expect(closes()).toBe(1);
});

test("shutdown closes the pending process and stops new sign-ins", async () => {
  const { login, closes } = fixture();
  const { loginId } = await login.start(caller, target);
  await login.shutdown();
  expect(closes()).toBe(1);
  await expect(login.complete(caller, loginId, "example")).rejects.toThrow("Start sign-in again");
  await expect(login.start(caller, target)).rejects.toThrow("Start sign-in again");
});

test("failed cleanup retains the caller slot until cleanup can be retried", async () => {
  let attempts = 0;
  const { login, closes } = fixture(undefined, undefined, async () => {
    if (++attempts < 3) throw Error("private process diagnostic");
  });
  const { loginId } = await login.start(caller, target);
  await expect(login.cancel(caller, loginId)).rejects.toThrow(/^Antigravity sign-in failed\. Start sign-in again\.$/);
  await expect(login.start(caller, target)).rejects.toThrow(/^Antigravity sign-in failed\. Start sign-in again\.$/);
  await login.shutdown();
  expect(closes()).toBe(1);
});

test.each(["cancel", "shutdown", "deadline"] as const)(
  "%s during cleanup suppresses the successful exchange",
  async (reason) => {
    const { promise: closing, resolve: startedClosing } = Promise.withResolvers<void>();
    const { promise: cleanup, resolve: finishCleanup } = Promise.withResolvers<void>();
    const { login, exit, deadline } = fixture(undefined, undefined, () => {
      startedClosing();
      return cleanup;
    });
    const { loginId } = await login.start(caller, target);
    const complete = login.complete(caller, loginId, "example");
    exit(0);
    await closing;
    let stop: Promise<void> | undefined;
    if (reason === "cancel") stop = login.cancel(caller, loginId);
    else if (reason === "shutdown") stop = login.shutdown();
    else deadline.abort();
    finishCleanup();
    await stop;
    await expect(complete).rejects.toThrow(
      reason === "deadline" ? "Start sign-in again." : "Antigravity sign-in failed.",
    );
  },
);

test("a new start retries failed cleanup even if the first start never returned a login ID", async () => {
  let starts = 0;
  let cleanupAttempts = 0;
  const login = createAntigravityLogin(
    async () => {
      const first = ++starts === 1;
      const { promise: exited, resolve: exit } = Promise.withResolvers<number>();
      return {
        authorizationUrl: Promise.resolve(first ? "https://example.com" : authorization.href),
        exited,
        async submitCode() {},
        async readToken() {},
        async close() {
          if (first && ++cleanupAttempts === 1) throw Error("profile in use");
          exit(1);
        },
      };
    },
    { now: () => 0, deadline: () => new AbortController().signal },
  );
  await expect(login.start(caller, target)).rejects.toThrow("Antigravity sign-in failed.");
  const next = await login.start(caller, target);
  expect(next.authorizationUrl).toBe(authorization.href);
  expect(cleanupAttempts).toBe(2);
  await login.shutdown();
});
