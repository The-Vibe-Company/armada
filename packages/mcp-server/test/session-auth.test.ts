import { expect, spyOn, test } from "bun:test";
import type { AuthStore, Membership } from "@armada/auth";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { AuthUnavailable, authenticateCaller } from "../src/caller.ts";

const issuer = "https://project.supabase.co/auth/v1";
const userId = "11111111-1111-4111-8111-111111111111";
const sessionId = "22222222-2222-4222-8222-222222222222";
const orgId = "33333333-3333-4333-8333-333333333333";
const now = new Date("2026-11-14T00:00:00Z");
const key = await generateKeyPair("ES256");
const jwk = { ...(await exportJWK(key.publicKey)), kid: "fixture_key", alg: "ES256" };
async function token(claims: Record<string, unknown> = {}, signingKey = key.privateKey, kid = "fixture_key") {
  return new SignJWT({
    sub: userId,
    session_id: sessionId,
    role: "authenticated",
    iat: now.getTime() / 1000,
    exp: now.getTime() / 1000 + 3600,
    iss: issuer,
    aud: "authenticated",
    ...claims,
  })
    .setProtectedHeader({ alg: "ES256", kid })
    .sign(signingKey);
}

test("ES256 callers reuse only public keys and freshly check session and memberships every request", async () => {
  let fetches = 0,
    reads = 0;
  let memberships: Membership[] | null = [{ orgId, name: "Example", role: "member" }];
  const store = {
    sessionMemberships: async (user: string, session: string, instant: string) => {
      reads++;
      expect([user, session, instant]).toEqual([userId, sessionId, now.toISOString()]);
      return memberships;
    },
  } as unknown as AuthStore;
  const supabase = {
    supabaseUrl: "https://project.supabase.co",
    anonKey: "public_placeholder",
    fetch: async (url: string | URL | Request, init?: RequestInit) => {
      fetches++;
      expect(String(url)).toBe(`${issuer}/.well-known/jwks.json`);
      expect(new Headers(init?.headers).get("authorization")).toBeNull();
      return Response.json({ keys: [jwk] });
    },
  };
  const authorization = `Bearer ${await token()}`;
  const options = { store, supabase, now };
  expect(await authenticateCaller(authorization, options)).toMatchObject({
    ok: true,
    caller: { via: "supabase", orgs: [{ orgId, role: "member" }] },
  });
  memberships = [{ orgId, name: "Example", role: "admin" }];
  expect(await authenticateCaller(authorization, options)).toMatchObject({
    ok: true,
    caller: { orgs: [{ role: "admin" }] },
  });
  memberships = [];
  expect(await authenticateCaller(authorization, options)).toMatchObject({ ok: true, caller: { orgs: [] } });
  memberships = null;
  expect(await authenticateCaller(authorization, options)).toEqual({ ok: false });
  expect([fetches, reads]).toEqual([1, 4]);
});

test("invalid signed claims, signatures and unknown keys never reach the session store", async () => {
  let reads = 0;
  const other = await generateKeyPair("ES256");
  const options = {
    now,
    store: {
      sessionMemberships: async () => {
        reads++;
        return [];
      },
    } as unknown as AuthStore,
    supabase: {
      supabaseUrl: "https://project.supabase.co",
      anonKey: "public_placeholder",
      fetch: async () => Response.json({ keys: [jwk] }),
    },
  };
  for (const jwt of [
    await token({ exp: now.getTime() / 1000 }),
    await token({ iss: "https://foreign.supabase.co/auth/v1" }),
    await token({ aud: "service_role" }),
    await token({ role: "service_role" }),
    await token({ session_id: "not_uuid" }),
    await token({}, other.privateKey),
    await token({}, key.privateKey, "unknown_key"),
  ]) {
    expect(await authenticateCaller(`Bearer ${jwt}`, options)).toEqual({ ok: false });
  }
  expect(reads).toBe(0);
});

test("only Armada's CLI OAuth client can use a client-bound Supabase session", async () => {
  const cliOAuthClientId = "armada-cli";
  const options = {
    now,
    store: {
      sessionMemberships: async () => [],
      memberships: async () => [],
    } as unknown as AuthStore,
    supabase: {
      supabaseUrl: "https://project.supabase.co",
      anonKey: "public_placeholder",
      cliOAuthClientId,
      fetch: async (url: string | URL | Request) => {
        if (String(url) === `${issuer}/.well-known/jwks.json`) return Response.json({ keys: [jwk] });
        expect(String(url)).toBe(`${issuer}/oauth/userinfo`);
        return Response.json({ sub: userId });
      },
    },
  };
  const symmetricToken = (client_id: string) =>
    new SignJWT({ sub: userId, client_id }).setProtectedHeader({ alg: "HS256" }).sign(new Uint8Array(32));
  for (const signed of [token, (claims: { client_id: string }) => symmetricToken(claims.client_id)]) {
    const foreign = await signed({ client_id: "other-client" });
    const cli = await signed({ client_id: cliOAuthClientId });
    expect((await authenticateCaller(`Bearer ${foreign}`, options)).ok).toBe(false);
    expect((await authenticateCaller(`Bearer ${cli}`, options)).ok).toBe(true);
  }
});

test("public key cache expires after sixty seconds without accepting removed keys or bypassing outages", async () => {
  let time = now.getTime(),
    fetches = 0,
    available = true;
  const clock = spyOn(Date, "now").mockImplementation(() => time);
  const options = {
    now,
    store: { sessionMemberships: async () => [] } as unknown as AuthStore,
    supabase: {
      supabaseUrl: "https://project.supabase.co",
      anonKey: "public_placeholder",
      fetch: async () => {
        fetches++;
        if (!available) throw new Error("private_transport_detail");
        return Response.json({ keys: fetches === 1 ? [jwk] : [] });
      },
    },
  };
  try {
    const authorization = `Bearer ${await token()}`;
    expect((await authenticateCaller(authorization, options)).ok).toBe(true);
    time += 60_001;
    expect(await authenticateCaller(authorization, options)).toEqual({ ok: false });
    expect(fetches).toBe(2);
    time += 60_001;
    available = false;
    await expect(authenticateCaller(authorization, options)).rejects.toBeInstanceOf(AuthUnavailable);
    expect(fetches).toBe(3);
  } finally {
    clock.mockRestore();
  }
});
