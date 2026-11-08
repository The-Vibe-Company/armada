import { AuthError } from "./errors.ts";
import { page } from "./html.ts";
import { createPkce } from "./pkce.ts";
import type { SessionStore } from "./session.ts";
import { assertSupabaseUrl, exchangeSupabaseCode, type Provider, supabaseAuthorizeUrl } from "./supabase-auth.ts";
import type { AuthFetch } from "./types.ts";

export interface LoginOptions {
  fetch: AuthFetch;
  supabaseUrl: string;
  anonKey: string;
  /** When set, the local page redirects straight to that provider. */
  provider?: Provider;
  open: (url: string) => void;
  session: SessionStore;
  now: () => Date;
  timeoutMs?: number;
  /** The local URL, which carries no secret. Printed so a user can open it by hand. */
  onUrl?: (url: string) => void;
}

/**
 * Browser login against Supabase Auth (GitHub or Google) with PKCE.
 * The Supabase session is stored on this machine. It is not an Armada service token.
 */
export async function loginWithBrowser(options: LoginOptions): Promise<{ userId: string }> {
  const supabaseUrl = assertSupabaseUrl(options.supabaseUrl);
  const provider = options.provider;
  const pkce = await createPkce();
  let finish: (code: string) => void = () => {};
  let fail: (error: Error) => void = () => {};
  const codePromise = new Promise<string>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new AuthError("Login timed out.", "unauthorized")),
      options.timeoutMs ?? 5 * 60 * 1000,
    );
    finish = (code) => {
      clearTimeout(timer);
      resolve(code);
    };
    fail = (error) => {
      clearTimeout(timer);
      reject(error);
    };
  });

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      const origin = url.origin;
      if (url.pathname === "/" && provider) return redirectProvider(provider, origin);
      if (url.pathname === "/") return chooser();
      if (url.pathname === "/github") return redirectProvider("github", origin);
      if (url.pathname === "/google") return redirectProvider("google", origin);
      if (url.pathname === "/callback") {
        const code = url.searchParams.get("code");
        if (!code || url.searchParams.get("error")) {
          fail(new AuthError("Login was declined.", "unauthorized"));
          return page("Login failed", "<p>You can close this window.</p>", 400);
        }
        finish(code);
        return page("Logged in", "<p>You can close this window.</p>");
      }
      return new Response("Not found", { status: 404 });
    },
  });

  function redirectProvider(name: Provider, origin: string): Response {
    const location = supabaseAuthorizeUrl({
      supabaseUrl,
      anonKey: options.anonKey,
      provider: name,
      redirectTo: `${origin}/callback`,
      challenge: pkce.challenge,
    });
    return new Response(null, { status: 302, headers: { location, "cache-control": "no-store" } });
  }

  try {
    const origin = `http://127.0.0.1:${server.port}/`;
    options.onUrl?.(origin);
    try {
      options.open(origin);
    } catch {
      // The URL was already handed to onUrl.
    }
    const code = await codePromise;
    const session = await exchangeSupabaseCode({
      fetch: options.fetch,
      supabaseUrl,
      anonKey: options.anonKey,
      code,
      verifier: pkce.verifier,
      now: options.now(),
    });
    await options.session.write(session);
    return { userId: session.userId };
  } finally {
    await server.stop(false);
  }
}

function chooser(): Response {
  return page(
    "Sign in to Armada",
    `<p><a href="/github">Continue with GitHub</a></p><p><a href="/google">Continue with Google</a></p>`,
  );
}
