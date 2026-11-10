import { expect, test } from "bun:test";
import { Client, type Deps, type Distribution, distribute, downloadProfile, token } from "./app-store-connect.ts";

async function key() {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const pkcs8 = Buffer.from(await crypto.subtle.exportKey("pkcs8", pair.privateKey)).toString("base64");
  const privateKey = `-----BEGIN PRIVATE KEY-----\n${pkcs8.match(/.{1,64}/g)?.join("\n")}\n-----END PRIVATE KEY-----`;
  return { publicKey: pair.publicKey, key: { id: "KEY123", issuer: "issuer-uuid", privateKey } };
}

type Route = (method: string, path: string, body: unknown) => { status?: number; body?: unknown };

// A fake App Store Connect: records every call and answers from `route`.
async function fake(route: Route) {
  const calls: { method: string; path: string; body: unknown }[] = [];
  const logs: string[] = [];
  let clock = 0;
  const deps: Deps = {
    fetch: async (url, init) => {
      const path = url.replace("https://api.appstoreconnect.apple.com", "");
      const body = init.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ method: String(init.method), path: decodeURIComponent(path), body });
      expect(String((init.headers as Record<string, string>).authorization)).toStartWith("Bearer ");
      const answer = route(String(init.method), decodeURIComponent(path), body);
      return new Response(answer.body === undefined ? null : JSON.stringify(answer.body), {
        status: answer.status ?? 200,
      });
    },
    sleep: async (ms) => {
      clock += ms;
    },
    log: (line) => logs.push(line),
    now: () => clock,
  };
  return { client: new Client((await key()).key, deps), deps, calls, logs };
}

const target: Distribution = {
  appId: "6832706228",
  version: "1.0.0",
  build: "1042",
  group: "Armada Internal",
  whatToTest: "Check sign-in.",
};

const build = (state: string, encryption: boolean | null = false) => ({
  id: "build-1",
  attributes: { version: "1042", processingState: state, usesNonExemptEncryption: encryption },
});

test("signs an ES256 token App Store Connect accepts", async () => {
  const { publicKey, key: apiKey } = await key();
  const jwt = await token(apiKey, 1_700_000_000);
  const [header, payload, signature] = jwt.split(".") as [string, string, string];
  expect(JSON.parse(Buffer.from(header, "base64url").toString())).toEqual({ alg: "ES256", kid: "KEY123", typ: "JWT" });
  expect(JSON.parse(Buffer.from(payload, "base64url").toString())).toEqual({
    iss: "issuer-uuid",
    iat: 1_700_000_000,
    exp: 1_700_000_900,
    aud: "appstoreconnect-v1",
  });
  const valid = await crypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    publicKey,
    Buffer.from(signature, "base64url"),
    Buffer.from(`${header}.${payload}`),
  );
  expect(valid).toBe(true);
});

test("downloads only the exactly named active App Store profile", async () => {
  const profile = (name: string, uuid: string) => ({
    id: uuid,
    attributes: { name, uuid, profileContent: Buffer.from(`profile ${uuid}`).toString("base64") },
  });
  const { client, calls } = await fake(() => ({
    body: { data: [profile("Armada App Store Old", "old"), profile("Armada App Store", "current")] },
  }));
  const result = await downloadProfile(client, "Armada App Store");
  expect(result.uuid).toBe("current");
  expect(result.content.toString()).toBe("profile current");
  expect(calls[0]?.path).toContain("filter[profileType]=IOS_APP_STORE");
  expect(calls[0]?.path).toContain("filter[profileState]=ACTIVE");

  const none = await fake(() => ({ body: { data: [] } }));
  await expect(downloadProfile(none.client, "Armada App Store")).rejects.toThrow(
    'Expected exactly one active App Store profile named "Armada App Store", found 0.',
  );
});

test("waits for processing, sets What to Test and adds the build to the group", async () => {
  const states = ["", "PROCESSING", "VALID"];
  const { client, deps, calls } = await fake((method, path) => {
    if (path.startsWith("/v1/builds?")) {
      const state = states.shift() ?? "VALID";
      return { body: { data: state ? [build(state)] : [] } };
    }
    if (path === "/v1/builds/build-1/betaBuildLocalizations") return { body: { data: [] } };
    if (path === "/v1/betaBuildLocalizations" && method === "POST") return { status: 201, body: { data: {} } };
    if (path.startsWith("/v1/betaGroups?")) {
      return {
        body: { data: [{ id: "group-1", attributes: { name: "Armada Internal", hasAccessToAllBuilds: false } }] },
      };
    }
    if (path === "/v1/betaGroups/group-1/relationships/builds") return { status: 204 };
    throw new Error(`unexpected ${method} ${path}`);
  });
  await distribute(client, deps, target);
  expect(calls.filter((call) => call.path.startsWith("/v1/builds?"))).toHaveLength(3);
  expect(calls[0]?.path).toContain("filter[version]=1042");
  expect(calls[0]?.path).toContain("filter[preReleaseVersion.version]=1.0.0");
  expect(calls.slice(3).map(({ method, path, body }) => ({ method, path, body }))).toEqual([
    { method: "GET", path: "/v1/builds/build-1/betaBuildLocalizations", body: undefined },
    {
      method: "POST",
      path: "/v1/betaBuildLocalizations",
      body: {
        data: {
          type: "betaBuildLocalizations",
          attributes: { locale: "en-US", whatsNew: "Check sign-in." },
          relationships: { build: { data: { type: "builds", id: "build-1" } } },
        },
      },
    },
    {
      method: "GET",
      path: "/v1/betaGroups?filter[app]=6832706228&filter[name]=Armada Internal&fields[betaGroups]=name,isInternalGroup,hasAccessToAllBuilds",
      body: undefined,
    },
    {
      method: "POST",
      path: "/v1/betaGroups/group-1/relationships/builds",
      body: { data: [{ type: "builds", id: "build-1" }] },
    },
  ]);
});

test("updates an existing What to Test and leaves an all-builds group alone", async () => {
  const { client, deps, calls, logs } = await fake((method, path) => {
    if (path.startsWith("/v1/builds?")) return { body: { data: [build("VALID")] } };
    if (path === "/v1/builds/build-1/betaBuildLocalizations") {
      return { body: { data: [{ id: "loc-1", attributes: { locale: "en-US", whatsNew: "old" } }] } };
    }
    if (path === "/v1/betaBuildLocalizations/loc-1" && method === "PATCH") return { body: { data: {} } };
    if (path.startsWith("/v1/betaGroups?")) {
      return {
        body: { data: [{ id: "group-1", attributes: { name: "Armada Internal", hasAccessToAllBuilds: true } }] },
      };
    }
    throw new Error(`unexpected ${method} ${path}`);
  });
  await distribute(client, deps, target);
  expect(calls.map((call) => call.method)).toEqual(["GET", "GET", "PATCH", "GET"]);
  expect(calls[2]?.body).toEqual({
    data: { type: "betaBuildLocalizations", id: "loc-1", attributes: { whatsNew: "Check sign-in." } },
  });
  expect(logs).toContain('Group "Armada Internal" already receives every build automatically.');
});

test("stops on a failed build, a missing compliance answer or a build that never appears", async () => {
  const invalid = await fake(() => ({ body: { data: [build("INVALID")] } }));
  await expect(distribute(invalid.client, invalid.deps, target)).rejects.toThrow(
    "Build 1.0.0 (1042) processing ended INVALID",
  );

  const undeclared = await fake(() => ({ body: { data: [build("VALID", null)] } }));
  await expect(distribute(undeclared.client, undeclared.deps, target)).rejects.toThrow(
    "has usesNonExemptEncryption=null",
  );
  expect(undeclared.calls).toHaveLength(1);

  const missing = await fake(() => ({ body: { data: [] } }));
  await expect(distribute(missing.client, missing.deps, target)).rejects.toThrow(
    "is not processed after 60 minutes (state not visible yet)",
  );

  const refused = await fake(() => ({ status: 403, body: { errors: [{ code: "FORBIDDEN_ERROR" }] } }));
  await expect(distribute(refused.client, refused.deps, target)).rejects.toThrow(
    "App Store Connect GET /v1/builds failed with 403",
  );
});
