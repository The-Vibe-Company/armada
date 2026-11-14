import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultSessionPath, productionAuthIo } from "../src/auth-commands.ts";
import { run } from "../src/run.ts";

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
    expect(await run(["--profile", "staging", "list", "--json"], io, { auth })).toBe(0);
    expect(calls).toEqual(["https://stage.example/api/v1/sandbox/list"]);
    expect(await run(["list", "--json"], io, { auth: { ...auth, env: { ...env, ARMADA_PROFILE: "staging" } } })).toBe(
      0,
    );
    expect(calls).toHaveLength(2);
    expect(
      await run(["--profile=staging", "list"], io, {
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
    expect(await run(["--profile", "chosen", "list"], io, { auth })).toBe(2);
    expect(errors).toContain("--profile chosen login --url");
    for (const name of ["../other", "", "a/b", ".", "x".repeat(65)]) {
      expect(await run([`--profile=${name}`, "list"], io, { auth })).toBe(2);
    }
    expect(await run(["--profile", "one", "--profile", "two", "list"], io, { auth })).toBe(2);
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
      return Response.json({});
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
    await writeFile(defaultSessionPath(auth.env), "invalid-json");
    const calls: string[] = [];
    auth.fetch = async (url) => {
      calls.push(String(url));
      return Response.json({ methods: [] });
    };
    // Stop at method discovery: it proves the old malformed session did not prevent a new login.
    expect(await run(["login", "--url", "https://stage.example", "--provider", "github"], io, { auth })).toBe(2);
    expect(calls).toEqual(["https://stage.example/api/v1/auth/methods"]);
    expect(await run(["logout"], io, { auth })).toBe(0);
    expect(await auth.session.read()).toBeNull();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
