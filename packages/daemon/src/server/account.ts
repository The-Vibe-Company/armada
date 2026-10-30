import {
  API_KEY_VARIABLE,
  type ArmadaApi,
  ArmadaApiError,
  apiBaseUrl,
  armadaAddress,
  armadaApi,
  DEFAULT_ARMADA_API_URL,
  displayCode,
  machinePaths,
  RETIRED_VARIABLES,
  readCredentialStore,
  resolveCredentials,
  SESSION_TOKEN_VARIABLE,
  SIGNED_IN_TO_VARIABLE,
  updateCredentialStore,
  waitForApproval,
} from "@armada/core/account";
import type { PluginContext } from "@armada/plugin-api";
import { RuntimeLaunchRefusal } from "@armada/plugin-api";
import {
  type AccountDevice,
  type AccountRequest,
  type AccountState,
  type ServerMessage,
  PROTOCOL_VERSION as version,
} from "@armada/protocol";
import type { Keychain } from "../keychain.ts";
import { readPluginSecret } from "../plugins/keychain.ts";

interface AccountOptions {
  env?: Record<string, string | undefined>;
  fetch?: (url: string, init: RequestInit) => Promise<Response>;
  keychain?: Pick<Keychain, "read">;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  /** Receives fixed diagnostic lines, never API error text or a credential. */
  log?: (line: string) => void;
}
const MAX_AGE = 5 * 60_000;
type StoredSession = { token: string; url: string };
type Keys = { linear: string | null; github: string | null };
type Login = { controller: AbortController; device: Promise<Omit<AccountDevice, "id">>; done: Promise<void> };

/** One shared device flow and live credential getter for this daemon's lifetime. */
export class Account {
  readonly apiUrl: string;
  readonly secrets: PluginContext["secrets"];
  private readonly env: Record<string, string | undefined>;
  private readonly api: ArmadaApi | null;
  private readonly now: () => Date;
  private readonly listeners = new Set<(state: AccountState) => void>();
  private state: AccountState;
  private token: string | null = null;
  private checkedAt = -Infinity;
  private refreshing: Promise<void> | undefined;
  private cache = new Map<string, { at: number; keys: Promise<Keys> }>();
  private login: Login | undefined;
  private mutations = Promise.resolve();
  private closed = false;
  private closing: Promise<void> | undefined;

  private readonly options: AccountOptions;

  constructor(options: AccountOptions = {}) {
    this.options = options;
    this.env = options.env ?? process.env;
    this.now = options.now ?? (() => new Date());
    // Invalid optional account configuration must not prevent local plugin boot.
    let url = DEFAULT_ARMADA_API_URL;
    let api: ArmadaApi | null = null;
    try {
      url = armadaAddress(apiBaseUrl(this.env.ARMADA_API_URL || url).toString());
      api = this.apiAt(url);
    } catch {
      this.warn();
    }
    this.apiUrl = url;
    this.api = api;
    this.state = { signedIn: false, apiUrl: this.apiUrl };
    this.secrets = { get: (name, project) => this.secret(name, project) };
  }

  subscribe(listener: (state: AccountState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private warn(): void {
    this.options.log?.("Armada account unavailable; using local plugin credentials when available");
  }
  private publish(next: AccountState): void {
    if (this.closed) return;
    const changed = JSON.stringify(next) !== JSON.stringify(this.state);
    this.state = next;
    if (changed) for (const listener of this.listeners) listener(next);
  }
  private enqueue(run: () => Promise<void>): Promise<void> {
    const next = this.mutations.then(run);
    this.mutations = next.catch(() => {});
    return next;
  }
  private apiAt(url: string): ArmadaApi {
    return armadaApi({ url, fetch: this.options.fetch, timeoutMs: 5000, sleep: this.options.sleep, now: this.now });
  }
  private sessionOf(store: Record<string, string>): StoredSession | null {
    const url = armadaAddress(store[SIGNED_IN_TO_VARIABLE] || DEFAULT_ARMADA_API_URL);
    // Lifecycle operations own the stored web session even when an env API key
    // wins for CLI commands, or this daemon now uses a different API address.
    const credentials = resolveCredentials({ env: { ARMADA_API_URL: url }, store });
    return credentials.armadaSignIn?.kind === "session" ? { token: credentials.armadaSignIn.token, url } : null;
  }
  private async storedSession(): Promise<StoredSession | null> {
    const paths = machinePaths(this.env);
    return paths ? this.sessionOf((await readCredentialStore(paths.credentials)).values) : null;
  }
  private async storedToken(): Promise<string | null> {
    const session = await this.storedSession();
    return this.api && session?.url === this.apiUrl ? session.token : null;
  }
  private async revoke(session: StoredSession): Promise<void> {
    try {
      await this.apiAt(session.url).signOut({ kind: "session", token: session.token });
    } catch {
      this.warn();
    }
  }

  /** Also detects sign-in changes made by armada login/logout in another terminal. */
  async refresh(force = false): Promise<void> {
    if (this.closed) return;
    if (this.refreshing) {
      await this.refreshing;
      if (!force) return;
    }
    this.refreshing = this.readAccount(force).finally(() => {
      this.refreshing = undefined;
    });
    return this.refreshing;
  }
  private async readAccount(force: boolean): Promise<void> {
    try {
      const token = await this.storedToken();
      const changed = token !== this.token;
      if (changed || force) this.cache.clear();
      this.token = token;
      if (!token) {
        this.checkedAt = this.now().getTime();
        this.publish({ signedIn: false, apiUrl: this.apiUrl });
        return;
      }
      if (!changed && !force && this.now().getTime() - this.checkedAt < MAX_AGE) return;
      this.checkedAt = this.now().getTime();
      const signIn = { kind: "session" as const, token };
      if (!this.api) return;
      const identity = await this.api.whoami(signIn);
      const projects = await this.api.projects(signIn);
      const keys = await this.keys();
      if (token !== this.token || this.closed) return;
      if (!identity.user || !identity.organization) {
        this.publish({ signedIn: false, apiUrl: this.apiUrl });
        return;
      }
      this.publish({
        signedIn: true,
        apiUrl: this.apiUrl,
        email: identity.user.email,
        organization: { name: identity.organization.name, slug: identity.organization.slug },
        projects: projects.map(({ slug, name }) => ({ slug, name })),
        keys: { linear: !!keys.linear, github: !!keys.github },
      });
    } catch (error) {
      this.warn();
      if (error instanceof ArmadaApiError && error.signedOut) {
        this.token = null;
        this.cache.clear();
        this.publish({ signedIn: false, apiUrl: this.apiUrl });
      }
    }
  }

  private async keys(project?: string): Promise<Keys> {
    const token = this.token;
    if (!token || this.closed || !this.api) return { linear: null, github: null };
    const scope = project ?? "";
    let entry = this.cache.get(scope);
    if (!entry || this.now().getTime() - entry.at >= MAX_AGE) {
      entry = {
        at: this.now().getTime(),
        keys: this.api
          .credentials({ kind: "session", token }, project ? { project } : null, { github: true })
          .then((answer) => ({ linear: answer.linear?.apiKey ?? null, github: answer.github?.token ?? null }))
          .catch(() => {
            this.warn();
            return { linear: null, github: null };
          }),
      };
      this.cache.set(scope, entry);
    }
    const result = await entry.keys;
    return token === this.token && !this.closed ? result : { linear: null, github: null };
  }

  private async secret(name: string, project?: string): Promise<string | null> {
    const environment = this.env[name]?.trim() || (name === "GITHUB_TOKEN" ? this.env.GH_TOKEN?.trim() : undefined);
    if (environment) return environment;
    if (name === "LINEAR_API_KEY" || name === "GITHUB_TOKEN") {
      if (this.now().getTime() - this.checkedAt >= MAX_AGE) await this.refresh();
      const keys = await this.keys(project);
      const value = name === "LINEAR_API_KEY" ? keys.linear : keys.github;
      if (value) return value;
    }
    return readPluginSecret(name, this.options.keychain, this.env);
  }

  /** Only the host uses this sign-in; neither plugins nor event payloads receive it. */
  private async workerSignIn() {
    await this.refresh();
    if (this.closed || !this.api || !this.token || !this.state.signedIn)
      throw new Error("Sign in to Armada in Settings to launch in Conductor");
    return { api: this.api, signIn: { kind: "session" as const, token: this.token } };
  }

  async assertWorkerSignIn(): Promise<void> {
    await this.refresh(true);
    await this.workerSignIn();
  }

  async launchWorkerToken(project: string, ticket: string) {
    const { api, signIn } = await this.workerSignIn();
    try {
      const launch = await api.launchToken(signIn, { project, ticket });
      if (
        launch.worker.project !== project ||
        launch.worker.ticket !== ticket ||
        typeof launch.worker.id !== "string" ||
        !/^[A-Za-z0-9_-]{1,128}$/.test(launch.worker.id) ||
        /^armada_(?:launch|worker|session|key)_/.test(launch.worker.id)
      )
        throw new Error("Invalid launch identity");
      return launch;
    } catch (error) {
      if (error instanceof ArmadaApiError && error.signedOut)
        throw new RuntimeLaunchRefusal("Sign in to Armada in Settings to launch in Conductor");
      if (error instanceof ArmadaApiError && error.status && error.status >= 400 && error.status < 500)
        throw new RuntimeLaunchRefusal("Armada could not authorize the Conductor launch");
      throw new Error("Armada launch authorization outcome unknown; inspect before retrying");
    }
  }

  async bindWorkerLaunch(target: { project: string; ticket: string; id: string; handle: string }) {
    const { api, signIn } = await this.workerSignIn();
    try {
      await api.bindLaunch(signIn, { ...target, runtime: "conductor" });
    } catch {
      throw new Error("Armada could not bind the Conductor launch");
    }
  }

  async revokeWorkerLaunch(target: { project: string; ticket: string; id: string }) {
    const { api, signIn } = await this.workerSignIn();
    try {
      await api.revokePendingLaunch(signIn, target);
    } catch {
      throw new Error("Armada could not revoke the Conductor launch");
    }
  }

  async releaseHostedWorker(
    project: { slug: string; name: string; repository: string; programRoot: string },
    target: { ticket: string; id: string; handle: string; reason: string; terminal?: "released" | "merged" },
  ) {
    const { api, signIn } = await this.workerSignIn();
    try {
      let value = await api.fleet(signIn, "runtime/handle", { project, input: { ticket: target.ticket } });
      if (!value) {
        try {
          return await api.revokePendingLaunch(signIn, { project: project.slug, ticket: target.ticket, id: target.id });
        } catch (error) {
          if (!(error instanceof ArmadaApiError) || error.status !== 409) throw error;
          value = await api.fleet(signIn, "runtime/handle", { project, input: { ticket: target.ticket } });
          if (!value) throw new Error("Hosted release identity unavailable");
        }
      }
      const held = value as { handle?: string; workerSessionId?: string; claimedAt?: string };
      if (held.handle !== target.handle || held.workerSessionId !== target.id || !held.claimedAt)
        throw new Error("Hosted generation changed");
      await api.fleet(signIn, "release", {
        project,
        input: { ticket: target.ticket, reason: target.reason, handle: target.handle, claimedAt: held.claimedAt },
      });
      await api.endWorkers(signIn, {
        project: project.slug,
        ticket: target.ticket,
        reason: target.terminal ?? "released",
        claimedAt: held.claimedAt,
      });
    } catch {
      throw new Error("Armada could not release the exact Conductor worker");
    }
  }

  async workerFleet(
    project: { slug: string; name: string; repository: string; programRoot: string },
    op: "inbox" | "events/since" | "runtime/handles" | "runtime/handle" | "answer",
    input: object,
  ): Promise<unknown> {
    const { api, signIn } = await this.workerSignIn();
    try {
      return await api.fleet(signIn, op, { project, input });
    } catch (error) {
      if (error instanceof ArmadaApiError && error.signedOut) {
        this.token = null;
        this.cache.clear();
        this.publish({ signedIn: false, apiUrl: this.apiUrl });
        throw new Error("Sign in to Armada in Settings to launch in Conductor");
      }
      throw new Error("Armada worker reading unavailable");
    }
  }

  private startLogin(): Login {
    if (!this.api || this.closed) throw new Error("Armada account unavailable");
    const api = this.api;
    const controller = new AbortController();
    const device = api.startDeviceLogin().then((code) => ({ code, at: this.now().getTime() }));
    const login: Login = {
      controller,
      device: device.then(({ code, at }) => ({
        type: "account.device",
        version,
        code: displayCode(code.userCode),
        verificationUrl: code.verificationUriComplete,
        expiresAt: new Date(at + code.expiresInSeconds * 1000).toISOString(),
      })),
      done: Promise.resolve(),
    };
    login.done = (async () => {
      const { code } = await device;
      controller.signal.throwIfAborted();
      const token = await waitForApproval({
        api,
        code,
        now: this.now,
        sleep: (ms) => this.sleep(ms, controller.signal),
      });
      try {
        await this.enqueue(async () => {
          controller.signal.throwIfAborted();
          const paths = machinePaths(this.env);
          if (!paths) throw new Error("Credential storage unavailable");
          await api.whoami({ kind: "session", token });
          controller.signal.throwIfAborted();
          const prior = (await readCredentialStore(paths.credentials)).values;
          const previous = this.sessionOf(prior);
          const restore: Record<string, string | null> = Object.fromEntries(
            [SESSION_TOKEN_VARIABLE, API_KEY_VARIABLE, SIGNED_IN_TO_VARIABLE].map((name) => [
              name,
              prior[name] ?? null,
            ]),
          );
          controller.signal.throwIfAborted();
          let installed = false;
          try {
            await updateCredentialStore(paths, {
              [SESSION_TOKEN_VARIABLE]: token,
              [API_KEY_VARIABLE]: null,
              [SIGNED_IN_TO_VARIABLE]: this.apiUrl,
              ...Object.fromEntries(RETIRED_VARIABLES.map((name) => [name, null])),
            });
            installed = true;
            controller.signal.throwIfAborted();
            if (previous && (previous.token !== token || previous.url !== this.apiUrl)) {
              await this.revoke(previous);
              restore[SESSION_TOKEN_VARIABLE] = null;
              if (!restore[API_KEY_VARIABLE]) restore[SIGNED_IN_TO_VARIABLE] = null;
            }
            await this.refresh(true);
            controller.signal.throwIfAborted();
          } catch (error) {
            if (installed) {
              const current = await this.storedSession();
              // Never overwrite a later sign-in made by another terminal.
              if (current?.token === token && current.url === this.apiUrl) await updateCredentialStore(paths, restore);
            }
            throw error;
          }
        });
      } catch (error) {
        await this.revoke({ token, url: this.apiUrl });
        throw error;
      }
    })();
    // Callers await both promises; keep rejected starts handled even during cancellation.
    void login.device.catch(() => {});
    void login.done
      .catch(() => {})
      .finally(() => {
        if (this.login === login) this.login = undefined;
      });
    return login;
  }

  private sleep(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = () => {
        signal.removeEventListener("abort", abort);
        if (timer) clearTimeout(timer);
        resolve();
      };
      const abort = () => {
        signal.removeEventListener("abort", abort);
        if (timer) clearTimeout(timer);
        reject(new Error("Sign-in cancelled"));
      };
      if (signal.aborted) return abort();
      signal.addEventListener("abort", abort, { once: true });
      if (this.options.sleep) void this.options.sleep(ms).then(finish, abort);
      else timer = setTimeout(finish, ms);
    });
  }

  async dispatch(request: AccountRequest, send: (message: ServerMessage) => void): Promise<void> {
    try {
      if (request.type === "account.login") {
        this.login ??= this.startLogin();
        const login = this.login;
        send({ ...(await login.device), id: request.id });
        await login.done;
      } else if (request.type === "account.logout") {
        this.login?.controller.abort();
        await this.enqueue(async () => {
          const session = await this.storedSession();
          if (session) await this.revoke(session);
          const paths = machinePaths(this.env);
          if (paths)
            await updateCredentialStore(paths, {
              [SESSION_TOKEN_VARIABLE]: null,
              [API_KEY_VARIABLE]: null,
              [SIGNED_IN_TO_VARIABLE]: null,
              ...Object.fromEntries(RETIRED_VARIABLES.map((name) => [name, null])),
            });
          await this.refresh(true);
        });
      } else await this.refresh();
      send({ type: "account.result", version, id: request.id, ...this.state });
    } catch (error) {
      const code =
        error instanceof ArmadaApiError && /denied/.test(error.message)
          ? "denied"
          : error instanceof ArmadaApiError && /expired/.test(error.message)
            ? "expired"
            : "offline";
      send({
        type: "error",
        version,
        id: request.id,
        code,
        message:
          code === "denied"
            ? "Sign-in was denied"
            : code === "expired"
              ? "Sign-in code expired"
              : "Could not reach Armada or its credential storage",
      });
    }
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    this.login?.controller.abort();
    this.listeners.clear();
    this.cache.clear();
    this.token = null;
    this.closing = Promise.allSettled([this.login?.done, this.mutations]).then(() => {});
    return this.closing;
  }
}
