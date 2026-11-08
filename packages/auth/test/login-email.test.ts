import { describe, expect, test } from "bun:test";
import { loginWithEmail } from "../src/login.ts";
import { s256 } from "../src/pkce.ts";
import { memorySessionStore } from "../src/session.ts";
import type { AuthFetch } from "../src/types.ts";

const USER = "11111111-1111-4111-8111-111111111111";
const SUPABASE = "https://project.supabase.co";
const NOW = new Date("2026-11-08T12:00:00.000Z");

const session = () =>
  Response.json({ access_token: "access", refresh_token: "refresh", expires_in: 3600, user: { id: USER } });

/** A Supabase that records the sign-in email request and accepts one code. */
function supabase(options: { validCode?: string; sendStatus?: number } = {}) {
  const sent: { email: string; redirectTo: string; challenge: string }[] = [];
  const verified: string[] = [];
  let exchange: (code: string, verifier: string) => Promise<boolean> = async () => false;
  const fetchFn: AuthFetch = async (input, init) => {
    const url = new URL(String(input));
    const body = JSON.parse(String(init?.body)) as Record<string, string>;
    if (url.pathname === "/auth/v1/otp") {
      if (options.sendStatus) return new Response("{}", { status: options.sendStatus });
      sent.push({
        email: body.email ?? "",
        redirectTo: url.searchParams.get("redirect_to") ?? "",
        challenge: body.code_challenge ?? "",
      });
      return Response.json({});
    }
    if (url.pathname === "/auth/v1/verify") {
      verified.push(body.token ?? "");
      if (body.type !== "email" || body.email !== sent[0]?.email || body.token !== options.validCode) {
        return Response.json({ msg: "Token has expired or is invalid" }, { status: 403 });
      }
      return session();
    }
    if (url.pathname === "/auth/v1/token" && url.searchParams.get("grant_type") === "pkce") {
      return (await exchange(body.auth_code ?? "", body.code_verifier ?? ""))
        ? session()
        : new Response("no", { status: 400 });
    }
    return new Response("unexpected", { status: 500 });
  };
  return {
    fetch: fetchFn,
    sent,
    verified,
    acceptLink(code: string) {
      exchange = async (got, verifier) => got === code && (await s256(verifier)) === sent[0]?.challenge;
    },
  };
}

const base = (fake: ReturnType<typeof supabase>, store = memorySessionStore()) => ({
  fetch: fake.fetch,
  supabaseUrl: SUPABASE,
  anonKey: "anon",
  email: "ada@example.com",
  session: store,
  now: () => NOW,
});

describe("email login", () => {
  test("a code typed from the email signs in and stores the session", async () => {
    const fake = supabase({ validCode: "123456" });
    const store = memorySessionStore();
    const result = await loginWithEmail({ ...base(fake, store), readCode: async () => " 123 456 " });
    expect(result.userId).toBe(USER);
    expect(fake.sent).toHaveLength(1);
    expect(fake.sent[0]?.email).toBe("ada@example.com");
    expect(fake.sent[0]?.redirectTo).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);
    expect(await store.read()).toMatchObject({ userId: USER, accessToken: "access", supabaseUrl: SUPABASE });
  });

  test("the link comes back to the local page and its PKCE code signs in", async () => {
    const fake = supabase();
    fake.acceptLink("link-code");
    const store = memorySessionStore();
    const result = await loginWithEmail({
      ...base(fake, store),
      onSent: () => {
        void fetch(`${fake.sent[0]?.redirectTo}?code=link-code`);
      },
    });
    expect(result.userId).toBe(USER);
    expect((await store.read())?.userId).toBe(USER);
  });

  test("a wrong code is tried again, then refused after three", async () => {
    const fake = supabase({ validCode: "654321" });
    const answers = ["000000", "654321"];
    let wrong = 0;
    const store = memorySessionStore();
    await loginWithEmail({
      ...base(fake, store),
      readCode: async () => answers.shift() ?? "",
      onWrongCode: () => {
        wrong += 1;
      },
    });
    expect(wrong).toBe(1);
    expect(fake.verified).toEqual(["000000", "654321"]);

    const refused = supabase({ validCode: "654321" });
    const empty = memorySessionStore();
    await expect(loginWithEmail({ ...base(refused, empty), readCode: async () => "111111" })).rejects.toThrow(
      "That code is wrong or has expired.",
    );
    expect(refused.verified).toHaveLength(3);
    expect(await empty.read()).toBeNull();
  });

  test("an address that is not an email is refused before anything is sent", async () => {
    const fake = supabase();
    await expect(loginWithEmail({ ...base(fake), email: "not-an-email" })).rejects.toThrow("valid email");
    expect(fake.sent).toHaveLength(0);
  });

  test("a rate-limited or failed send says so", async () => {
    await expect(loginWithEmail(base(supabase({ sendStatus: 429 })))).rejects.toThrow("Too many sign-in emails");
    await expect(loginWithEmail(base(supabase({ sendStatus: 500 })))).rejects.toThrow("could not send");
  });
});
