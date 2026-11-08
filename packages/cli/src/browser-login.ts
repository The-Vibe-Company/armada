import { createPkce } from "@armada/auth";
import { armadaApiUrl } from "./armada-api.ts";

export interface SessionDto {
  accessToken: string;
  refreshToken: string;
  expiresAt: string;
}

/** Browser PKCE login through Armada only; provider details never enter the CLI. */
export async function browserLogin(options: {
  origin?: string;
  provider: "github" | "google";
  fetch: typeof fetch;
  open: (url: string) => void;
  timeoutMs?: number;
}): Promise<SessionDto> {
  const origin = armadaApiUrl(options.origin);
  const pkce = await createPkce();
  const state = crypto.randomUUID().replaceAll("-", "");
  let resolve!: (value: { code?: string; error?: Error }) => void;
  const code = new Promise<{ code?: string; error?: Error }>((done) => {
    resolve = done;
  });
  let rejectLogin!: (error: Error) => void;
  const failure = new Promise<never>((_, reject) => {
    rejectLogin = reject;
  });
  // Observe this rejection now, while retaining it for the caller's race below.
  void failure.catch(() => undefined);
  const callback = Promise.race([code, failure]);
  void callback.catch(() => undefined);
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      if (url.pathname !== "/callback" || url.searchParams.get("state") !== state) {
        rejectLogin(new Error("Login callback was refused."));
        return new Response("Login failed", { status: 400 });
      }
      const value = url.searchParams.get("code");
      if (!value || url.searchParams.get("error")) {
        rejectLogin(new Error("Login was declined."));
        return new Response("Login failed", { status: 400 });
      }
      resolve({ code: value });
      return new Response("Logged in. You can close this window.");
    },
  });
  try {
    const callback = `http://127.0.0.1:${server.port}/callback`;
    const authorize = new URL("/api/v1/auth/authorize", origin);
    authorize.searchParams.set("provider", options.provider);
    authorize.searchParams.set("redirect_uri", callback);
    authorize.searchParams.set("code_challenge", pkce.challenge);
    authorize.searchParams.set("state", state);
    options.open(authorize.toString());
    const timeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("Login timed out.")), options.timeoutMs ?? 300_000),
    );
    const result = await Promise.race([callback, timeout]);
    if (!result.code) throw new Error("Login callback was refused.");
    const response = await options.fetch(new URL("/api/v1/auth/exchange", origin), {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ code: result.code, verifier: pkce.verifier }),
    });
    const dto = (await response.json()) as Partial<SessionDto>;
    if (
      !response.ok ||
      typeof dto.accessToken !== "string" ||
      typeof dto.refreshToken !== "string" ||
      typeof dto.expiresAt !== "string"
    )
      throw new Error("Login exchange was refused.");
    return dto as SessionDto;
  } finally {
    await server.stop(false);
  }
}
