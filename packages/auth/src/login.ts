import { AuthError } from "./errors.ts";
import { page } from "./html.ts";
import { createPkce } from "./pkce.ts";
import type { Session, SessionStore } from "./session.ts";
import {
  assertEmail,
  assertEmailCode,
  assertSupabaseUrl,
  exchangeSupabaseCode,
  type Provider,
  sendEmailLink,
  supabaseAuthorizeUrl,
  verifyEmailCode,
} from "./supabase-auth.ts";
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

export interface EmailLoginOptions {
  fetch: AuthFetch;
  supabaseUrl: string;
  anonKey: string;
  email: string;
  session: SessionStore;
  now: () => Date;
  timeoutMs?: number;
  /**
   * Reads the code typed from the email. Without it only the link signs in. The signal aborts when the
   * link signed in first, so the prompt can stop reading.
   */
  readCode?: (signal: AbortSignal) => Promise<string>;
  /** Called once the email is sent, before the wait. */
  onSent?: (email: string) => void;
  /** Called when a typed code was refused and another try is allowed. */
  onWrongCode?: () => void;
}

const CODE_TRIES = 3;

/**
 * Email login against Supabase Auth. The email carries a link, which comes back to a local page with a
 * PKCE code, and, when the project's template includes it, a one-time code that can be typed instead.
 * Whichever arrives first signs in. The session is stored on this machine, as `loginWithBrowser` does.
 */
export async function loginWithEmail(options: EmailLoginOptions): Promise<{ userId: string }> {
  const supabaseUrl = assertSupabaseUrl(options.supabaseUrl);
  const email = assertEmail(options.email);
  const pkce = await createPkce();
  const typing = new AbortController();

  let settled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let resolveSession: (session: Session) => void = () => {};
  let rejectSession: (error: unknown) => void = () => {};
  const outcome = new Promise<Session>((resolve, reject) => {
    resolveSession = resolve;
    rejectSession = reject;
  });
  outcome.catch(() => {});
  const succeed = (session: Session) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    resolveSession(session);
  };
  const failWith = (error: unknown) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    rejectSession(error);
  };
  timer = setTimeout(
    () => failWith(new AuthError("Login timed out.", "unauthorized")),
    options.timeoutMs ?? 5 * 60 * 1000,
  );

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname !== "/callback") return new Response("Not found", { status: 404 });
      const code = url.searchParams.get("code");
      if (!code || url.searchParams.get("error")) {
        failWith(new AuthError("Login was declined.", "unauthorized"));
        return page("Login failed", "<p>You can close this window.</p>", 400);
      }
      try {
        succeed(
          await exchangeSupabaseCode({
            fetch: options.fetch,
            supabaseUrl,
            anonKey: options.anonKey,
            code,
            verifier: pkce.verifier,
            now: options.now(),
          }),
        );
        return page("Logged in", "<p>You can close this window.</p>");
      } catch (error) {
        failWith(error);
        return page("Login failed", "<p>You can close this window.</p>", 400);
      }
    },
  });

  async function typeCode(readCode: (signal: AbortSignal) => Promise<string>): Promise<void> {
    for (let attempt = 1; attempt <= CODE_TRIES && !settled; attempt += 1) {
      try {
        const code = assertEmailCode(await readCode(typing.signal));
        if (settled) return;
        succeed(
          await verifyEmailCode({
            fetch: options.fetch,
            supabaseUrl,
            anonKey: options.anonKey,
            email,
            code,
            now: options.now(),
          }),
        );
        return;
      } catch (error) {
        if (settled) return;
        const retry = error instanceof AuthError && (error.code === "unauthorized" || error.code === "usage");
        if (!retry || attempt === CODE_TRIES) {
          failWith(
            error instanceof AuthError && error.code === "unauthorized"
              ? new AuthError("That code is wrong or has expired.", "unauthorized")
              : error,
          );
          return;
        }
        options.onWrongCode?.();
      }
    }
  }

  try {
    await sendEmailLink({
      fetch: options.fetch,
      supabaseUrl,
      anonKey: options.anonKey,
      email,
      redirectTo: `http://127.0.0.1:${server.port}/callback`,
      challenge: pkce.challenge,
    });
    options.onSent?.(email);
    if (options.readCode) void typeCode(options.readCode);
    const session = await outcome;
    await options.session.write(session);
    return { userId: session.userId };
  } finally {
    typing.abort();
    clearTimeout(timer);
    await server.stop(false);
  }
}
