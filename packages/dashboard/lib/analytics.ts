// Product analytics with PostHog, as pure rules over an injected environment:
// whether the dashboard reports, with which project key and to which host.
// Armada's own production deployment (Vercel production, built from
// The-Vibe-Company/armada) reports to Armada's PostHog project unless
// NEXT_PUBLIC_POSTHOG_KEY names another. Anywhere else (a fork's or another
// owner's deployment, previews, local development, the tests, CI's performance
// job) nothing is reported unless NEXT_PUBLIC_POSTHOG_KEY is set explicitly.
// The project key is public: PostHog only accepts events with it. The browser
// calls PostHog's host directly, never through this app, so no cookie of the
// dashboard's ever reaches PostHog.

export const ANALYTICS_VARIABLES = { key: "NEXT_PUBLIC_POSTHOG_KEY", host: "NEXT_PUBLIC_POSTHOG_HOST" } as const;

/** Armada's PostHog project (US cloud). */
export const POSTHOG_PROJECT_KEY = "phc_wFiYmJ2FcxQbMEouYdJ5c7hbRUUBTo2xdq7VqWjvyxVG";
/** Where PostHog takes events. */
export const POSTHOG_API_HOST = "https://us.i.posthog.com";
/** PostHog's own app, for the links its toolbar opens. */
export const POSTHOG_UI_HOST = "https://us.posthog.com";
/** The repository whose production deployment reports to Armada's project without a key set (Vercel's system variables). */
const ARMADA_REPOSITORY = { owner: "The-Vibe-Company", slug: "armada" };

export interface Analytics {
  key: string;
  /** PostHog's address: PostHog's US cloud unless NEXT_PUBLIC_POSTHOG_HOST names another. */
  host: string;
}

type Env = Record<string, string | undefined>;

const same = (a: string | undefined, b: string) => a?.toLowerCase() === b.toLowerCase();
const armadaProduction = (env: Env) =>
  env.VERCEL_ENV === "production" &&
  same(env.VERCEL_GIT_REPO_OWNER, ARMADA_REPOSITORY.owner) &&
  same(env.VERCEL_GIT_REPO_SLUG, ARMADA_REPOSITORY.slug);

/** Whether and where this deployment reports; null when it does not. */
export function analyticsOf(env: Env): Analytics | null {
  const set = env[ANALYTICS_VARIABLES.key]?.trim();
  const key = set || (armadaProduction(env) ? POSTHOG_PROJECT_KEY : "");
  if (!key) return null;
  return { key, host: env[ANALYTICS_VARIABLES.host]?.trim().replace(/\/+$/, "") || POSTHOG_API_HOST };
}

/**
 * One-time codes some addresses carry (`/device?user_code=`, OAuth's `code` and
 * `state`), plain or percent-encoded inside another address (`/login?next=%2Fdevice%3Fuser_code%3D…`):
 * never sent to PostHog.
 */
const ONE_TIME_PARAMS = /((?:[?&]|%3F|%26)(?:user_code|code|state)(?:=|%3D))(?:(?!%26)[^&#"';\s])*/gi;

/** `value` with the one-time codes of any address in it masked; other values unchanged. */
export const withoutOneTimeCodes = <T>(value: T): T =>
  (typeof value === "string" ? value.replace(ONE_TIME_PARAMS, "$1<masked>") : value) as T;

export interface NewAccount {
  id: string;
  email: string;
  name: string;
}

type Fetch = (input: string, init: RequestInit) => Promise<Response>;

/**
 * Records `signed_up` once, when Better Auth creates an account (GitHub's
 * first sign-in, or an email sign-up before its confirmation), under the
 * account's id: the id the browser identifies the person with afterwards.
 * Analytics never fail a sign-up: an error is logged and dropped.
 */
export async function captureSignUp(a: Analytics, user: NewAccount, fetch: Fetch): Promise<void> {
  try {
    const res = await fetch(`${a.host}/i/v0/e/`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        api_key: a.key,
        event: "signed_up",
        distinct_id: user.id,
        properties: { $set: { email: user.email, name: user.name } },
      }),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) console.error(`armada dashboard: analytics refused signed_up (${res.status})`);
  } catch (err) {
    console.error(`armada dashboard: analytics unavailable: ${err instanceof Error ? err.message : String(err)}`);
  }
}
