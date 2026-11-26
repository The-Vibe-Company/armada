import { expect, test } from "bun:test";
import type { AuthIo } from "../src/auth-commands.ts";
import { run } from "../src/run.ts";
import { memorySessionStore, type Session } from "../src/session.ts";

import { loginAuthorized, loginStarted } from "./device-login.fixture.ts";

const saved: Session = {
  armadaUrl: "https://armada.example",
  accessToken: "old-access",
  refreshToken: "old-refresh",
  expiresAt: "2099-01-01",
};

function fixture(initial: Session | null = null) {
  let out = "";
  let err = "";
  let invitations = 0;
  let logins = 0;
  let commands = 0;
  let rejectNewSession = false;
  const auth: AuthIo = {
    env: { ARMADA_URL: "https://armada.example" },
    session: memorySessionStore(initial),
    interactive: true,
    confirmSignIn: async () => {
      invitations++;
      return true;
    },
    out: (value) => {
      out += value;
    },
    err: (value) => {
      err += value;
    },
    now: () => new Date("2026-11-13"),
    open: () => {},
    sleep: async () => {},
    fetch: async (input, init) => {
      const path = new URL(String(input)).pathname;
      if (path.endsWith("/auth/device/start")) {
        logins++;
        return loginStarted();
      }
      if (path.endsWith("/auth/device/poll")) return loginAuthorized();
      if (path.endsWith("/auth/refresh")) return Response.json({ msg: "private provider diagnostic" }, { status: 401 });
      if (path.endsWith("/token/whoami") || path.endsWith("/account/status")) {
        commands++;
        expect(init?.method).toBe("POST");
        return !rejectNewSession && new Headers(init?.headers).get("authorization") === "Bearer new-access"
          ? Response.json({ auth: "login", userId: "user" })
          : Response.json({ msg: "private provider diagnostic" }, { status: 401 });
      }
      throw new Error(`Unexpected path ${path}`);
    },
  };
  return {
    auth,
    run: (args: string[]) => run(args, auth, { auth }),
    output: () => ({ out, err, invitations, logins, commands }),
    rejectRetry: () => {
      rejectNewSession = true;
    },
  };
}

for (const [name, initial, commands] of [
  ["missing", null, 1],
  ["expired", { ...saved, expiresAt: "2000-01-01" }, 1],
  ["revoked", saved, 2],
] as const) {
  test(`interactive ${name} session invites login and completes the original command`, async () => {
    const state = fixture(initial);
    expect(await state.run(["whoami"])).toBe(0);
    expect(state.output()).toMatchObject({
      invitations: 1,
      logins: 1,
      commands,
      out: "Signed in as user@example.test.\nuser (saved login)\n",
    });
    expect(state.output().err).not.toContain("private provider diagnostic");
  });
}

test("a failed retried command never starts another login", async () => {
  const state = fixture();
  state.rejectRetry();
  expect(await state.run(["whoami"])).toBe(3);
  expect(state.output()).toMatchObject({ invitations: 1, logins: 1, commands: 1 });
  expect(state.output().err).toContain("Run armada login.");
});

for (const json of [false, true]) {
  test(`noninteractive authentication failure gives safe login instructions (${json ? "JSON" : "text"})`, async () => {
    const state = fixture(saved);
    state.auth.interactive = false;
    expect(await state.run(["whoami", ...(json ? ["--json"] : [])])).toBe(3);
    expect(state.output()).toMatchObject({ invitations: 0, logins: 0, out: "" });
    if (json)
      expect(JSON.parse(state.output().err)).toEqual({
        error: {
          code: "unauthorized",
          message: "You are not signed in. Run armada login.",
          hint: "Next step: run armada login.",
        },
      });
    else expect(state.output().err).toContain("Run armada login.");
    expect(state.output().err).not.toContain("private provider diagnostic");
  });
}

test("declining the invitation leaves the command unexecuted", async () => {
  const state = fixture();
  state.auth.confirmSignIn = async () => false;
  expect(await state.run(["whoami"])).toBe(3);
  expect(state.output()).toMatchObject({ logins: 0, commands: 0 });
});

test("an invalid environment token is never replaced by interactive login", async () => {
  const state = fixture();
  state.auth.env.ARMADA_TOKEN = `armada_sk_${"a".repeat(43)}`;
  expect(await state.run(["whoami"])).toBe(3);
  expect(state.output()).toMatchObject({
    invitations: 0,
    logins: 0,
    err: expect.stringContaining("expired, or revoked"),
  });
});

for (const args of [[], ["--help"], ["--version"], ["whoami", "--help"]]) {
  test(`${args.length ? args.join(" ") : "bare armada"} stays available without authentication`, async () => {
    const state = fixture();
    expect(await state.run(args)).toBe(0);
    expect(state.output()).toMatchObject({ invitations: 0, logins: 0, commands: 0 });
  });
}

test("invited login preserves browser denial guidance", async () => {
  const state = fixture();
  const original = state.auth.fetch;
  state.auth.fetch = async (input, init) =>
    String(input).endsWith("/device/poll") ? Response.json({ status: "access_denied" }) : original(input, init);
  expect(await state.run(["whoami"])).toBe(3);
  expect(state.output().err).toContain("denied in the browser");
});

test("a typed server 401 after successful refresh still offers login", async () => {
  const state = fixture(saved);
  let refreshes = 0;
  let resourceCalls = 0;
  const original = state.auth.fetch;
  state.auth.fetch = async (input, init) => {
    const path = new URL(String(input)).pathname;
    if (path.endsWith("/auth/refresh")) {
      refreshes++;
      return Response.json({ accessToken: "still-rejected", refreshToken: "rotated", expiresAt: "2099-01-01" });
    }
    if (path.endsWith("/templates/list")) {
      resourceCalls++;
      return new Headers(init?.headers).get("authorization") === "Bearer new-access"
        ? Response.json({ items: [] })
        : Response.json({ error: { code: "unauthorized" } }, { status: 401 });
    }
    return original(input, init);
  };
  expect({
    code: await state.run(["template", "list", "--org", "11111111-1111-4111-8111-111111111111"]),
    error: state.output().err,
  }).toEqual({ code: 0, error: expect.any(String) });
  expect(refreshes).toBe(1);
  expect(resourceCalls).toBe(3);
  expect(state.output().invitations).toBe(1);
});

test("account logout never invites a user to log in first", async () => {
  const state = fixture(saved);
  state.auth.fetch = async () => Response.json({}, { status: 401 });
  expect(await state.run(["account", "logout"])).toBe(3);
  expect(state.output().invitations).toBe(0);
});
