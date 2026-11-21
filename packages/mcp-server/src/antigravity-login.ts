import { parseAntigravityCredential } from "@armada/core/antigravity-credential";

const lifetimeMs = 5 * 60_000;
const callbackUrl = "https://antigravity.google/oauth-callback";
const maxUrlLength = 8192;
const codePattern = /^[\w./~-]{1,2048}$/;

export type LoginCaller = { userId: string; orgId: string };
export type LoginTarget = { name: string } | { id: string; expectedVersion: number };

export interface AntigravityLoginProcess {
  authorizationUrl: Promise<string>;
  exited: Promise<number | null>;
  submitCode(code: string): Promise<void>;
  readToken(): Promise<unknown>;
  close(): Promise<void>;
}

type StartProcess = (signal: AbortSignal) => Promise<AntigravityLoginProcess>;
type Pending = {
  id: string;
  target: LoginTarget;
  expiresAt: number;
  state?: string;
  completing: boolean;
  cancelled: boolean;
  abort: AbortController;
  process: Promise<AntigravityLoginProcess>;
  closing?: Promise<void>;
  deadline: AbortSignal;
  onDeadline: () => void;
};

const messages = {
  already_pending: "An Antigravity sign-in is already pending.",
  login_missing: "Start sign-in again.",
  invalid_code: "Enter the code or callback URL from the matching Google sign-in.",
  login_failed: "Antigravity sign-in failed. Start sign-in again.",
} as const;

export class AntigravityLoginError extends Error {
  constructor(readonly reason: keyof typeof messages) {
    super(messages[reason]);
  }
}

function validatedLink(raw: string) {
  if (raw.length > maxUrlLength || /\s/.test(raw)) throw new AntigravityLoginError("login_failed");
  const url = new URL(raw);
  const states = url.searchParams.getAll("state");
  const redirects = url.searchParams.getAll("redirect_uri");
  if (
    url.origin !== "https://accounts.google.com" ||
    url.username ||
    url.password ||
    url.hash ||
    !["/o/oauth2/v2/auth", "/o/oauth2/auth"].includes(url.pathname) ||
    redirects.length !== 1 ||
    redirects[0] !== callbackUrl ||
    states.length !== 1 ||
    !states[0]
  )
    throw new AntigravityLoginError("login_failed");
  return { url: url.href, state: states[0] };
}

function validatedCode(value: string, state: string) {
  if (codePattern.test(value) && !/\s/.test(value)) return value;
  if (value.length <= maxUrlLength && !/\s/.test(value)) {
    const url = URL.parse(value);
    if (
      url?.origin === "https://antigravity.google" &&
      url.pathname === "/oauth-callback" &&
      !url.username &&
      !url.password &&
      !url.hash
    ) {
      const codes = url.searchParams.getAll("code");
      const states = url.searchParams.getAll("state");
      if (
        codes.length === 1 &&
        states.length === 1 &&
        states[0] === state &&
        codes[0] &&
        codePattern.test(codes[0]) &&
        !/\s/.test(codes[0])
      )
        return codes[0];
    }
  }
  throw new AntigravityLoginError("invalid_code");
}

function callerKey(caller: LoginCaller) {
  return JSON.stringify([caller.userId, caller.orgId]);
}

export function createAntigravityLogin(
  startProcess: StartProcess,
  clock = { now: Date.now, deadline: (ms: number) => AbortSignal.timeout(ms) },
) {
  const pending = new Map<string, Pending>();
  let stopped = false;

  function close(key: string, login: Pending) {
    if (login.closing) return login.closing;
    login.deadline.removeEventListener("abort", login.onDeadline);
    login.closing = login.process
      .then(
        (child) => child.close(),
        () => undefined,
      )
      .then(() => {
        pending.delete(key);
      })
      .catch(() => {
        delete login.closing;
        throw new AntigravityLoginError("login_failed");
      });
    login.abort.abort();
    return login.closing;
  }

  function retire(key: string, login: Pending) {
    void close(key, login).catch(() => {});
  }

  function expired(login: Pending) {
    return login.deadline.aborted || clock.now() >= login.expiresAt;
  }

  function assertLive(login: Pending) {
    if (login.abort.signal.aborted || expired(login)) {
      throw new AntigravityLoginError("login_missing");
    }
  }

  return {
    async start(caller: LoginCaller, target: LoginTarget) {
      const key = callerKey(caller);
      const previous = pending.get(key);
      if (!stopped && previous?.abort.signal.aborted && !previous.closing) await close(key, previous);
      if (stopped) throw new AntigravityLoginError("login_missing");
      if (pending.has(key)) throw new AntigravityLoginError("already_pending");

      const abort = new AbortController();
      const deadline = clock.deadline(lifetimeMs);
      const login: Pending = {
        id: crypto.randomUUID(),
        target: { ...target },
        expiresAt: clock.now() + lifetimeMs,
        completing: false,
        cancelled: false,
        abort,
        process: Promise.resolve().then(() => startProcess(abort.signal)),
        deadline,
        onDeadline: () => retire(key, login),
      };
      pending.set(key, login);
      deadline.addEventListener("abort", login.onDeadline, { once: true });
      if (deadline.aborted) login.onDeadline();

      try {
        const child = await login.process;
        const link = validatedLink(await child.authorizationUrl);
        assertLive(login);
        login.state = link.state;
        void child.exited.then(
          () => {
            if (!login.completing) retire(key, login);
          },
          () => retire(key, login),
        );
        return { loginId: login.id, authorizationUrl: link.url, expiresAt: new Date(login.expiresAt).toISOString() };
      } catch {
        await close(key, login);
        throw new AntigravityLoginError("login_failed");
      }
    },

    async complete(caller: LoginCaller, id: string, input: string) {
      const key = callerKey(caller);
      const login = pending.get(key);
      if (!login || login.id !== id || !login.state || login.completing) {
        throw new AntigravityLoginError("login_missing");
      }
      assertLive(login);
      const code = validatedCode(input, login.state);
      login.completing = true;
      let credential: ReturnType<typeof parseAntigravityCredential>;
      try {
        const child = await login.process;
        assertLive(login);
        await child.submitCode(code);
        if ((await child.exited) !== 0) throw new AntigravityLoginError("login_failed");
        assertLive(login);
        credential = parseAntigravityCredential({ method: "google", token: await child.readToken() });
        assertLive(login);
      } catch {
        throw new AntigravityLoginError("login_failed");
      } finally {
        await close(key, login);
      }
      if (stopped || login.cancelled || expired(login)) throw new AntigravityLoginError("login_failed");
      return { target: login.target, credential };
    },

    async cancel(caller: LoginCaller, id: string) {
      const key = callerKey(caller);
      const login = pending.get(key);
      if (!login || login.id !== id) throw new AntigravityLoginError("login_missing");
      login.cancelled = true;
      await close(key, login);
    },

    async shutdown() {
      stopped = true;
      const results = await Promise.allSettled([...pending].map(([key, login]) => close(key, login)));
      if (results.some((result) => result.status === "rejected")) throw new AntigravityLoginError("login_failed");
    },
  };
}
