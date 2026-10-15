import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { PostHog } from "posthog-js";
import { startPostHog, withPostHog } from "../components/Analytics.tsx";
import { type Auth, createAuth, type EmailMessage } from "../lib/accounts.ts";
import { accountsModeOf } from "../lib/accounts-settings.ts";
import {
  analyticsOf,
  captureSignUp,
  type NewAccount,
  POSTHOG_PROJECT_KEY,
  withoutOneTimeCodes,
} from "../lib/analytics.ts";
import type { Database } from "../lib/db.ts";
import { tempDatabase } from "./support.ts";

// Synthetic people, keys and secrets, for these tests only.
const BASE = "http://localhost:4838";
const OWNER = "owner@example.test";
const PASSWORD = "a synthetic password";
const KEY = "phc_synthetic_test_key";

describe("whether the dashboard reports to PostHog", () => {
  const ARMADA = {
    VERCEL_ENV: "production",
    VERCEL_GIT_REPO_OWNER: "The-Vibe-Company",
    VERCEL_GIT_REPO_SLUG: "armada",
  };

  test("Armada's own production reports to Armada's project; elsewhere only an explicit key turns it on", () => {
    expect(analyticsOf(ARMADA)).toEqual({ key: POSTHOG_PROJECT_KEY, host: "https://us.i.posthog.com" });
    for (const env of [
      {},
      { NODE_ENV: "development" },
      { NODE_ENV: "production" },
      { ...ARMADA, VERCEL_ENV: "preview" },
      // A fork or another owner's copy deployed to production: its people are not Armada's to count.
      { ...ARMADA, VERCEL_GIT_REPO_OWNER: "someone-else" },
      { VERCEL_ENV: "production" },
    ])
      expect(analyticsOf(env)).toBeNull();
    expect(analyticsOf({ NEXT_PUBLIC_POSTHOG_KEY: KEY })).toEqual({ key: KEY, host: "https://us.i.posthog.com" });
    expect(
      analyticsOf({ NEXT_PUBLIC_POSTHOG_KEY: KEY, NEXT_PUBLIC_POSTHOG_HOST: "https://eu.i.posthog.com/" }),
    ).toEqual({ key: KEY, host: "https://eu.i.posthog.com" });
  });

  test("never sends a one-time code an address carries", () => {
    expect(withoutOneTimeCodes(`${BASE}/device?user_code=ABCD-EFGH`)).toBe(`${BASE}/device?user_code=<masked>`);
    expect(withoutOneTimeCodes(`${BASE}/login?next=%2F&code=x1&state=y2#top`)).toBe(
      `${BASE}/login?next=%2F&code=<masked>&state=<masked>#top`,
    );
    expect(withoutOneTimeCodes(`${BASE}/login?next=%2Fdevice%3Fuser_code%3DABCD-EFGH%26x%3D1&lang=fr`)).toBe(
      `${BASE}/login?next=%2Fdevice%3Fuser_code%3D<masked>%26x%3D1&lang=fr`,
    );
    expect(withoutOneTimeCodes(`${BASE}/agents/WID-1?ticket=WID-1`)).toBe(`${BASE}/agents/WID-1?ticket=WID-1`);
    expect(withoutOneTimeCodes(42)).toBe(42);
  });
});

describe("signed_up", () => {
  test("is sent from the server to PostHog under the account's id; a failure never throws", async () => {
    const sent: { url: string; body: unknown }[] = [];
    const user = { id: "user-1", email: OWNER, name: "Olive Owner" };
    await captureSignUp({ key: KEY, host: "https://us.i.posthog.com" }, user, async (url, init) => {
      sent.push({ url, body: JSON.parse(String(init.body)) });
      return new Response("{}");
    });
    expect(sent).toEqual([
      {
        url: "https://us.i.posthog.com/i/v0/e/",
        body: {
          api_key: KEY,
          event: "signed_up",
          distinct_id: "user-1",
          properties: { $set: { email: OWNER, name: "Olive Owner" } },
        },
      },
    ]);
    const quiet = console.error;
    console.error = () => {};
    try {
      await captureSignUp({ key: KEY, host: "https://us.i.posthog.com" }, user, async () => {
        throw new Error("synthetic outage");
      });
    } finally {
      console.error = quiet;
    }
  });

  let client: Database;
  let auth: Auth;
  const outbox: EmailMessage[] = [];
  const signUps: NewAccount[] = [];

  beforeAll(async () => {
    client = await tempDatabase();
    const mode = accountsModeOf({
      NODE_ENV: "test",
      ARMADA_DATABASE_URL: "postgresql://armada@db.example.test/armada",
      ARMADA_AUTH_SECRET: "a synthetic secret for tests, long enough",
      ARMADA_AUTH_URL: BASE,
      ARMADA_AUTH_OWNER_EMAILS: OWNER,
    });
    if (mode.kind !== "accounts") throw new Error("test settings incomplete");
    auth = createAuth(mode.settings, {
      client,
      sender: { send: async (m) => void outbox.push(m) },
      onSignUp: (user) => void signUps.push(user),
    });
  });

  afterAll(async () => {
    await client.end();
  });

  test("is told once per account created: not for a refused sign-up, the confirmation or a later sign-in", async () => {
    await auth.api.signUpEmail({ body: { email: "stranger@example.test", name: "S", password: PASSWORD } });
    expect(signUps).toEqual([]);
    await auth.api.signUpEmail({ body: { email: OWNER, name: "Olive Owner", password: PASSWORD } });
    const link = outbox.findLast((m) => m.kind === "verification" && m.to === OWNER);
    await auth.handler(new Request(link?.url ?? ""));
    await auth.api.signInEmail({ body: { email: OWNER, password: PASSWORD } });
    const rs = await client.query(`SELECT "id" FROM "user" WHERE "email" = $1`, [OWNER]);
    expect(signUps).toEqual([{ id: String(rs.rows[0]?.id), email: OWNER, name: "Olive Owner" }]);
  });
});

describe("PostHog in the browser", () => {
  test("what a page asks before PostHog loaded runs once it started, in order, then at once; addresses are masked", () => {
    const calls: string[] = [];
    let config: { capture_pageview?: unknown; before_send?: (e: unknown) => unknown } = {};
    const posthog = {
      init: (key: string, c: typeof config) => {
        config = c;
        calls.push(`init ${key}`);
      },
      identify: (id: string, props: { email: string }) => calls.push(`identify ${id} ${props.email}`),
      reset: () => calls.push("reset"),
    } as unknown as PostHog;
    withPostHog((p) => p.identify("user-1", { email: OWNER, name: "Olive Owner" }));
    expect(calls).toEqual([]);
    startPostHog(posthog, { key: KEY, host: "https://us.i.posthog.com" });
    expect(calls).toEqual([`init ${KEY}`, `identify user-1 ${OWNER}`]);
    expect(config.capture_pageview).toBe("history_change");
    withPostHog((p) => p.reset());
    expect(calls.at(-1)).toBe("reset");
    expect(
      config.before_send?.({
        event: "$pageview",
        properties: { $current_url: `${BASE}/device?user_code=ABCD-EFGH`, $pathname: "/device" },
        $set_once: { $initial_current_url: `${BASE}/device?user_code=ABCD-EFGH` },
      }),
    ).toEqual({
      event: "$pageview",
      properties: { $current_url: `${BASE}/device?user_code=<masked>`, $pathname: "/device" },
      $set: undefined,
      $set_once: { $initial_current_url: `${BASE}/device?user_code=<masked>` },
    });
  });
});
