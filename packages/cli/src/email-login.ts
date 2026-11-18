import { AuthError, createPkce } from "@armada/auth";
import { authClient } from "@armada/sdk/auth";
import type { AuthIo } from "./auth-commands.ts";
import type { SessionDto } from "./browser-login.ts";

const CODE_REFUSAL =
  "Could not verify this code. It may be incorrect, expired, or already used. Opening the email link uses up the code. Request a new code and enter it without opening the link.";

/** A link carries only a state-bound PKCE code, never tokens or a browser session. */
export async function emailLogin(io: AuthIo, email: string, origin: string): Promise<SessionDto> {
  const pkce = await createPkce();
  const state = crypto.randomUUID().replaceAll("-", "");
  const controller = new AbortController();
  let completeLink!: (session: SessionDto) => void;
  const link = new Promise<SessionDto>((resolve) => {
    completeLink = resolve;
  });
  let exchanging = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const client = authClient(origin, (input, init) => io.fetch(input, init));
  type EmailOperation = Parameters<typeof client.email>[0];
  const post = async (operation: EmailOperation, body: unknown): Promise<Response> => {
    try {
      return await client.email(operation, body, controller.signal);
    } catch {
      throw new AuthError("Armada could not reach the server.", "unavailable");
    }
  };
  const sessionFrom = async (operation: EmailOperation, body: unknown, failure: string): Promise<SessionDto> => {
    const response = await post(operation, body);
    const value = (await response.json().catch(() => null)) as
      | (Partial<SessionDto> & { error?: { code?: string; message?: string } })
      | null;
    if (!response.ok) {
      if (
        value?.error &&
        typeof value?.error?.message === "string" &&
        ["usage", "unauthorized", "unavailable"].includes(value.error.code ?? "")
      )
        throw new AuthError(value.error.message, value.error.code as "usage" | "unauthorized" | "unavailable");
      if (response.status === 401 || response.status === 403) throw new AuthError(failure, "unauthorized");
      throw new AuthError(
        "Email sign-in could not finish because Armada could not complete the request. Try again later.",
        "unavailable",
      );
    }
    if (
      !value ||
      typeof value.accessToken !== "string" ||
      typeof value.refreshToken !== "string" ||
      typeof value.expiresAt !== "string"
    )
      throw new AuthError(
        "Email sign-in could not finish because Armada returned an invalid session. Try signing in again; if this continues, contact the server operator.",
        "unavailable",
      );
    return { accessToken: value.accessToken, refreshToken: value.refreshToken, expiresAt: value.expiresAt };
  };
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (
        request.method !== "GET" ||
        url.pathname !== "/callback" ||
        url.searchParams.getAll("state").length !== 1 ||
        url.searchParams.get("state") !== state ||
        url.searchParams.getAll("code").length !== 1 ||
        !url.searchParams.get("code") ||
        url.searchParams.has("error")
      )
        return new Response("Login callback refused. You can still enter the email code in the terminal.", {
          status: 400,
        });
      if (exchanging || controller.signal.aborted) return new Response("Login already completing.", { status: 409 });
      exchanging = true;
      try {
        const session = await sessionFrom(
          "exchange",
          { code: url.searchParams.get("code"), verifier: pkce.verifier },
          "Email link was refused. Enter the email code in the terminal or request a new email.",
        );
        completeLink(session);
        return new Response("Logged in. You can close this window.", {
          headers: { "cache-control": "no-store", "referrer-policy": "no-referrer" },
        });
      } catch (error) {
        if (error instanceof AuthError)
          return new Response(error.message, { status: error.code === "unavailable" ? 503 : 400 });
        return new Response(
          "Email link was refused. Return to the terminal to enter the code or request a new email.",
          { status: 400 },
        );
      } finally {
        exchanging = false;
      }
    },
  });
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new AuthError("Email login timed out. Run armada login again.", "unauthorized")),
        io.timeoutMs ?? 300_000,
      );
    });
    const attempt = async () => {
      const response = await post("email/start", {
        email,
        redirect_uri: `http://127.0.0.1:${server.port}/callback`,
        code_challenge: pkce.challenge,
        state,
        cli_email_link: true,
      });
      if (!response.ok) {
        const value = (await response.json().catch(() => null)) as {
          error?: { code?: string; message?: string };
        } | null;
        if (
          ["usage", "unauthorized", "unavailable", "rate_limited"].includes(value?.error?.code ?? "") &&
          typeof value?.error?.message === "string"
        )
          throw new AuthError(
            value.error.message,
            value.error.code as "usage" | "unauthorized" | "unavailable" | "rate_limited",
          );
        throw new AuthError("Armada could not start email login. Try again later.", "unavailable");
      }
      controller.signal.throwIfAborted();
      io.err(
        `Sent a sign-in email to ${email}. Open its link on this machine, or type the code here (use one, not both).\n`,
      );
      const numeric = (async () => {
        if (!io.readCode) throw new AuthError("Email code input is unavailable.", "usage");
        return sessionFrom("email/verify", { email, code: await io.readCode(controller.signal) }, CODE_REFUSAL);
      })();
      return Promise.race([numeric, link]);
    };
    return await Promise.race([attempt(), timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    controller.abort();
    await server.stop(false);
  }
}
