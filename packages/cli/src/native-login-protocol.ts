import { VaultError } from "@armada/core";

// Codex 0.166 polls device approval for 15 minutes; allow its completion and file flush to finish.
export const NATIVE_CODEX_LOGIN_TIMEOUT_MS = 16 * 60_000;
export const NATIVE_CODEX_START_TIMEOUT_MS = 30_000;
const unpublished = " No account was published.";
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** Never forward native error bodies: token-exchange errors can contain provider-controlled secrets. */
function reported(error: unknown): string {
  const text =
    typeof error === "string" ? error : object(error) && typeof error.message === "string" ? error.message : "";
  const status = /\b(?:status(?: code)?|HTTP)\s*[:=(]?\s*([1-5]\d\d)\b/i.exec(text)?.[1];
  let reason = "login was rejected (unrecognized details withheld)";
  if (/device auth timed out after 15 minutes/i.test(text)) reason = "device approval expired after 15 minutes";
  else if (/^device auth failed with status /i.test(text)) reason = "device authorization polling failed";
  else if (/^device code exchange failed:/i.test(text)) reason = "the authorization-code/token exchange failed";
  else if (/^workspace routing discovery unauthorized/i.test(text)) reason = "workspace discovery was not authorized";
  else if (/^workspace routing discovery timed out/i.test(text))
    reason = "workspace discovery timed out after approval";
  else if (/^workspace routing discovery failed/i.test(text)) reason = "workspace discovery failed after approval";
  else if (/^failed to (?:load|reload) workspace requirements:/i.test(text))
    reason = "workspace requirements could not be loaded";
  else if (/^account changed before sign-in completed$/i.test(text))
    reason = "the selected account changed before completion";
  else if (/^Login was not completed$/i.test(text)) reason = "native sign-in did not complete";
  const rpcCodes: readonly unknown[] = [-32700, -32600, -32601, -32602, -32603, -32000];
  const rpc = object(error) && rpcCodes.includes(error.code) ? `; JSON-RPC ${error.code}` : "";
  return `Codex reported: ${reason}${status ? ` (HTTP ${status})` : ""}${rpc}`;
}

/** Pure owner of the native JSON-RPC login stages, also exercised without a process or provider. */
export class NativeCodexLoginProtocol {
  stage = "initializing the app-server";
  private loginId: string | undefined;
  constructor(
    private readonly send: (message: Record<string, unknown>) => void,
    private readonly device: (url: string, code: string) => void,
  ) {}
  failure(message: string): VaultError {
    return new VaultError("unavailable", `${message} (step: ${this.stage}).${unpublished}`);
  }
  start() {
    this.send({
      id: 1,
      method: "initialize",
      params: { clientInfo: { name: "armada-local-login", version: "1" }, capabilities: {} },
    });
  }
  receive(message: unknown): boolean {
    if (!object(message)) throw this.failure("Codex sent an invalid login protocol message");
    // Only our requests (or a connection-level parse error) can fail this login.
    // Other native notifications/responses are not another failed authorization.
    if (message.error && (message.id === 1 || message.id === 2 || message.id === null))
      throw this.failure(reported(message.error));
    if (message.id === 1) {
      if (!object(message.result)) throw this.failure("Codex returned an invalid initialization response");
      this.stage = "requesting a device code";
      this.send({ method: "initialized", params: {} });
      this.send({ id: 2, method: "account/login/start", params: { type: "chatgptDeviceCode" } });
    } else if (message.id === 2) {
      const r = message.result;
      let url: URL | undefined;
      try {
        if (object(r) && typeof r.verificationUrl === "string") url = new URL(r.verificationUrl);
      } catch {}
      if (
        !object(r) ||
        r.type !== "chatgptDeviceCode" ||
        typeof r.loginId !== "string" ||
        !r.loginId ||
        !url ||
        url.origin !== "https://auth.openai.com" ||
        url.pathname !== "/codex/device" ||
        url.search ||
        url.hash ||
        url.username ||
        url.password ||
        typeof r.userCode !== "string" ||
        !/^[A-Z0-9-]{4,32}$/.test(r.userCode)
      )
        throw this.failure("Codex returned an unsupported or unsafe device challenge");
      this.loginId = r.loginId;
      this.stage = "waiting for browser approval and Codex account setup";
      this.device(url.href, r.userCode);
    } else if (message.method === "account/login/completed") {
      const p = message.params;
      if (!object(p) || !this.loginId || p.loginId !== this.loginId)
        throw this.failure("Codex returned a completion for a different or missing login");
      if (p.success !== true) throw this.failure(reported(p.error));
      this.stage = "reading the approved authentication file";
      return true;
    }
    return false;
  }
  cancelled(signal: AbortSignal): VaultError {
    const reason: unknown = signal.reason;
    if (object(reason) && reason.name === "TimeoutError")
      return this.failure(
        this.loginId
          ? `Timed out after ${NATIVE_CODEX_LOGIN_TIMEOUT_MS / 60_000} minutes waiting for browser approval and Codex completion`
          : `Timed out after ${NATIVE_CODEX_START_TIMEOUT_MS / 1000} seconds starting Codex or requesting a device code`,
      );
    if (reason === "SIGHUP")
      return this.failure("The parent shell/session closed (SIGHUP); run login in a persistent terminal");
    if (reason === "SIGTERM") return this.failure("The login process was terminated (SIGTERM)");
    if (reason === "SIGINT") return this.failure("Native Codex login was cancelled by Ctrl-C (SIGINT)");
    return this.failure("Native Codex login was cancelled");
  }
  exited(code: number | null, signal: string | null): VaultError {
    const detail =
      code !== null ? `exit code ${code}` : signal && /^SIG[A-Z0-9]+$/.test(signal) ? signal : "closed process";
    return this.failure(`Codex exited before login finished (${detail})`);
  }
}

/** Native permits a null account_id; Armada's refresh/binding broker cannot safely use an unidentified account. */
export function validateNativeCodexAuth(raw: string, approved = true): string {
  const prefix = approved ? "Codex approved the login, but its auth.json" : "The native Codex ChatGPT auth.json";
  const fail = (detail: string): never => {
    throw new VaultError(approved ? "unavailable" : "invalid", `${prefix} ${detail}.${unpublished}`);
  };
  if (Buffer.byteLength(raw) > 65536) fail("exceeds 64 KiB");
  let auth: unknown;
  try {
    auth = JSON.parse(raw);
  } catch {
    fail("is not valid JSON");
  }
  if (!object(auth)) return fail("contains no native ChatGPT tokens");
  const tokens = auth.tokens;
  if (!object(tokens)) return fail("contains no native ChatGPT tokens");
  if (auth.OPENAI_API_KEY || (auth.auth_mode != null && auth.auth_mode !== "chatgpt"))
    fail("contains API-key or unsupported authentication, not a ChatGPT subscription");
  for (const [key, label] of [
    ["access_token", "access token"],
    ["refresh_token", "refresh token"],
    ["account_id", "stable ChatGPT account ID"],
  ] as const) {
    const value = tokens[key];
    if (typeof value !== "string" || !value.trim()) fail(`contains no ${label}`);
  }
  return raw;
}
