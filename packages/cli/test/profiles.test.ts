import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { productionAuthIo } from "../src/auth-commands.ts";
import { profileDirectory } from "../src/profiles.ts";
import { run } from "../src/run.ts";

import { loginAuthorized, loginStarted } from "./device-login.fixture.ts";

test("named profiles isolate sessions, logout and preferences while retaining the legacy default", async () => {
  const root = await mkdtemp(join(tmpdir(), "armada-profiles-"));
  try {
    const io = { out: () => {}, err: () => {} };
    const env = { XDG_CONFIG_HOME: root };
    const normal = productionAuthIo(io, env);
    const staging = productionAuthIo(io, { ...env, ARMADA_PROFILE: "staging" });
    const other = productionAuthIo(io, { ...env, ARMADA_PROFILE: "other" });
    const session = (origin: string, token: string) => ({
      armadaUrl: origin,
      accessToken: token,
      refreshToken: "fixture-refresh",
      expiresAt: "2099-01-01",
    });
    await normal.session.write(session("https://prod.example", "fixture-prod"));
    await staging.session.write(session("https://stage.example", "fixture-stage"));
    await normal.preferences?.write("https://same.example", "prod-org");
    await staging.preferences?.write("https://same.example", "stage-org");
    expect(await normal.preferences?.read("https://same.example")).toBe("prod-org");
    expect(await staging.preferences?.read("https://same.example")).toBe("stage-org");
    expect(await other.session.read()).toBeNull();
    const calls: string[] = [];
    const auth = {
      ...normal,
      fetch: async (url: string | URL | Request, init?: RequestInit) => {
        calls.push(String(url));
        expect(new Headers(init?.headers).get("authorization")).toBe("Bearer fixture-stage");
        return Response.json({ sandboxes: [] });
      },
    };
    expect(await run(["--profile", "staging", "ls", "--json"], io, { auth })).toBe(0);
    expect(calls).toEqual(["https://stage.example/api/v1/sandbox/list"]);
    expect(await run(["ls", "--json"], io, { auth: { ...auth, env: { ...env, ARMADA_PROFILE: "staging" } } })).toBe(0);
    expect(calls).toHaveLength(2);
    expect(
      await run(["--profile=staging", "ls"], io, {
        auth: { ...auth, env: { ...env, ARMADA_URL: "https://wrong.example" } },
      }),
    ).toBe(2);
    expect(calls).toHaveLength(2);
    expect(await run(["--profile=staging", "logout"], io, { auth })).toBe(0);
    expect((await normal.session.read())?.accessToken).toBe("fixture-prod");
    expect(await staging.session.read()).toBeNull();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("profile selection overrides the environment and rejects unsafe or unconfigured names without requests", async () => {
  const root = await mkdtemp(join(tmpdir(), "armada-profiles-"));
  try {
    let errors = "";
    const io = {
      out: () => {},
      err: (s: string) => {
        errors += s;
      },
    };
    const auth = {
      ...productionAuthIo(io, { XDG_CONFIG_HOME: root, ARMADA_PROFILE: "environment" }),
      fetch: async () => {
        throw new Error("Must not request");
      },
    };
    expect(await run(["--profile", "chosen", "ls"], io, { auth })).toBe(2);
    expect(errors).toContain("--profile chosen login --url");
    for (const name of ["../other", "", "a/b", ".", "x".repeat(65)]) {
      expect(await run([`--profile=${name}`, "ls"], io, { auth })).toBe(2);
    }
    expect(await run(["--profile", "one", "--profile", "two", "ls"], io, { auth })).toBe(2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test.each(["--help", "-h", "--version"])("exec payload %s does not bypass profile origin binding", async (payload) => {
  const root = await mkdtemp(join(tmpdir(), "armada-profiles-"));
  try {
    const io = { out: () => {}, err: () => {} };
    const auth = productionAuthIo(io, { XDG_CONFIG_HOME: root, ARMADA_PROFILE: "staging" });
    await auth.session.write({
      armadaUrl: "https://stage.example",
      accessToken: "fixture-stage",
      refreshToken: "fixture-refresh",
      expiresAt: "2099-01-01",
    });
    const calls: string[] = [];
    auth.fetch = async (url, init) => {
      calls.push(String(url));
      expect(JSON.parse(String(init?.body)).command).toBe(`echo ${payload} --profile payload`);
      return Response.json({
        id: "11111111-1111-4111-8111-111111111111",
        exitCode: 0,
        stdout: "",
        stderr: "",
        timedOut: false,
        truncated: false,
      });
    };
    expect(
      await run(["exec", "11111111-1111-4111-8111-111111111111", "--", "echo", payload, "--profile", "payload"], io, {
        auth,
      }),
    ).toBe(0);
    expect(calls).toEqual(["https://stage.example/api/v1/sandbox/exec"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a malformed profile session can be cleared or replaced through explicit-server login", async () => {
  const root = await mkdtemp(join(tmpdir(), "armada-profiles-"));
  try {
    const io = { out: () => {}, err: () => {} };
    const auth = productionAuthIo(io, { XDG_CONFIG_HOME: root, ARMADA_PROFILE: "staging" });
    await auth.session.write({ accessToken: "fixture", refreshToken: "fixture", expiresAt: "2099-01-01" });
    await writeFile(join(profileDirectory(auth.env), "session.json"), "invalid-json");
    const calls: string[] = [];
    auth.fetch = async (url) => {
      calls.push(String(url));
      if (String(url).endsWith("/start")) return loginStarted();
      if (String(url).endsWith("/org/list")) return Response.json({ orgs: [] });
      return loginAuthorized();
    };
    auth.open = () => {};
    auth.sleep = async () => {};
    expect(await run(["login", "--url", "https://stage.example"], io, { auth })).toBe(0);
    expect(calls).toEqual([
      "https://stage.example/api/v1/auth/device/start",
      "https://stage.example/api/v1/auth/device/poll",
      "https://stage.example/api/v1/org/list",
    ]);
    expect((await auth.session.read())?.armadaUrl).toBe("https://stage.example");
    expect(await run(["logout"], io, { auth })).toBe(0);
    expect(await auth.session.read()).toBeNull();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("default profile organization preferences use the saved login origin", async () => {
  const auth = productionAuthIo({ out: () => {}, err: () => {} }, {});
  const { memorySessionStore } = await import("../src/session.ts");
  auth.session = memorySessionStore({
    armadaUrl: "https://custom.example",
    accessToken: "saved_access",
    refreshToken: "saved_refresh",
    expiresAt: "2099-01-01",
  });
  const origins: string[] = [];
  auth.preferences = {
    read: async (origin) => {
      origins.push(origin);
      return "chosen_org";
    },
    write: async () => {},
  };
  let body: unknown;
  auth.fetch = async (input, init) => {
    expect(new URL(String(input)).origin).toBe("https://custom.example");
    body = JSON.parse(String(init?.body));
    return Response.json({ sandboxes: [] });
  };
  expect(
    await run(
      ["ls"],
      {
        out: () => {},
        err: () => {},
      },
      { auth },
    ),
  ).toBe(0);
  expect(origins).toEqual(["https://custom.example"]);
  expect(body).toEqual({ org: "chosen_org" });
});

test("exec rejects shell text without the argument separator", async () => {
  let stderr = "";
  const code = await run(
    ["exec", "11111111-1111-4111-8111-111111111111", "pwd"],
    { out: () => {}, err: (text) => (stderr += text) },
    { env: {} },
  );
  expect(code).toBe(2);
  expect(stderr).toContain("Use armada exec [sandbox-id] -- COMMAND");
});
