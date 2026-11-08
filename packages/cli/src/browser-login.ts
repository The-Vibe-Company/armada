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
  let resolve!: (code: string) => void;
  let reject!: (error: Error) => void;
  const code = new Promise<string>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      if (url.pathname !== "/callback" || url.searchParams.get("state") !== state) {
        reject(new Error("Login callback was refused."));
        return new Response("Login failed", { status: 400 });
      }
      const value = url.searchParams.get("code");
      if (!value || url.searchParams.get("error")) {
        reject(new Error("Login was declined."));
        return new Response("Login failed", { status: 400 });
      }
      resolve(value);
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
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(() => reject(new Error("Login timed out.")), options.timeoutMs ?? 300_000);
    });
    const value = await Promise.race([code, timeout]).finally(() => {
      if (timeoutId !== undefined) clearTimeout(timeoutId);
    });
    const response = await options.fetch(new URL("/api/v1/auth/exchange", origin), {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ code: value, verifier: pkce.verifier }),
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
