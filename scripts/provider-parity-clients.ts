import { createControlClient } from "../apps/dashboard/src/lib/control.ts";
import { createGateway, GatewayError, sandboxGateway } from "../apps/dashboard/src/lib/gateway.ts";
import { AuthError } from "../packages/auth/src/index.ts";
import { ArmadaApiError, createArmadaApiClient } from "../packages/cli/src/armada-api.ts";
import { operation } from "../packages/cli/src/operations.ts";

export type ProofClient = "dashboard" | "cli";
export class ClientProofError extends Error {
  constructor(
    readonly client: ProofClient,
    readonly code: string,
    readonly httpStatus?: number,
    readonly action: "send" | "stop" = "send",
    readonly writeRefused = false,
  ) {
    super(code);
  }
}
export interface ClientProofIo {
  fetch(url: string, init: RequestInit): Promise<Response>;
  now(): number;
  until: number;
  dispatch?(client: ProofClient): void;
}
const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
/** Shared production client transport; never reads a saved session or rewrites client bodies. */
export async function createParityClients(
  input: { id: string; org: string; origin: string; token: string },
  io: ClientProofIo,
  action: "send" | "stop",
) {
  let client: ProofClient = "dashboard";
  let expired = false;
  let lastStatus: number | undefined;
  let lastBusiness = false;
  function fail(code: string): never {
    throw new ClientProofError(client, code, undefined, action);
  }
  const relay = async (raw: string | URL | Request, init?: RequestInit) => {
    lastStatus = undefined;
    lastBusiness = false;
    const url = new URL(typeof raw === "string" ? raw : raw instanceof URL ? raw.href : raw.url);
    if (
      url.origin !== input.origin ||
      url.search ||
      url.hash ||
      ![
        "/mcp",
        `/api/v1/sandbox/${action}`,
        ...(action === "send" ? ["/api/v1/logs/read"] : ["/api/v1/sandbox/status"]),
      ].includes(url.pathname) ||
      init?.method !== "POST"
    )
      fail(`client_${action}_unexpected_request`);
    const body = object(JSON.parse(String(init.body)));
    let business = false;
    if (url.pathname === "/mcp") {
      if (body.method === "tools/call") {
        const params = object(body.params),
          args = object(params.arguments);
        if (params.name !== action || args.id !== input.id) fail(`client_${action}_unexpected_request`);
        business = true;
      } else if (!["initialize", "notifications/initialized"].includes(String(body.method)))
        fail(`client_${action}_unexpected_request`);
    } else {
      if (body.id !== input.id || body.org !== input.org) fail(`client_${action}_unexpected_request`);
      business = url.pathname === `/api/v1/sandbox/${action}`;
    }
    const remaining = io.until - io.now();
    if (remaining <= 0) {
      expired = true;
      fail(`client_${action}_timeout`);
    }
    const signal = AbortSignal.timeout(Math.max(1, Math.min(110_000, remaining)));
    lastStatus = undefined;
    lastBusiness = business;
    if (business) io.dispatch?.(client);
    const result = await io.fetch(url.href, {
      ...init,
      redirect: "error",
      signal: init?.signal ? AbortSignal.any([signal, init.signal]) : signal,
    });
    lastStatus = result.status;
    if (io.now() > io.until) {
      expired = true;
      fail(`client_${action}_timeout`);
    }
    return result;
  };
  let output = "";
  const noSession = async (): Promise<never> => fail(`client_${action}_session_fallback`);
  const auth = {
    env: { ARMADA_URL: input.origin, ARMADA_TOKEN: input.token },
    fetch: relay,
    session: { read: noSession, write: noSession, clear: noSession },
    now: () => new Date(io.now()),
    open: () => fail(`client_${action}_session_fallback`),
    out: (text: string) => {
      output += text;
      if (output.length > 262144) fail(`invalid_client_${action}_receipt`);
    },
    err: () => {},
  };
  const api = await createArmadaApiClient(auth);
  const dashboard = sandboxGateway(
    createGateway({ url: `${input.origin}/mcp`, token: input.token, fetch: relay as typeof fetch }),
    createControlClient({ serverUrl: input.origin, token: input.token, fetch: relay as typeof fetch }),
  );
  return {
    api,
    dashboard,
    fail,
    async command(argv: string[]) {
      output = "";
      const result = await operation(action, argv, auth, async () => fail(`client_${action}_file_read`));
      if (result !== 0) fail(`invalid_client_${action}_receipt`);
      try {
        return JSON.parse(output) as unknown;
      } catch {
        fail(`invalid_client_${action}_receipt`);
      }
    },
    async run<T>(selected: ProofClient, call: () => Promise<T>): Promise<T> {
      client = selected;
      try {
        return await call();
      } catch (error) {
        if (error instanceof ClientProofError) throw error;
        if (expired || io.now() >= io.until) fail(`client_${action}_timeout`);
        const code =
          error instanceof ArmadaApiError
            ? error.serverCode
            : error instanceof GatewayError
              ? error.code
              : error instanceof AuthError && error.code === "unauthorized"
                ? "unauthorized"
                : undefined;
        const status =
          error instanceof ArmadaApiError || error instanceof GatewayError
            ? error.status
            : lastStatus !== undefined && lastStatus >= 400
              ? lastStatus
              : undefined;
        const safeCode =
          typeof code === "string" && /^[a-zA-Z0-9_-]{1,80}$/.test(code)
            ? code
            : status === 401
              ? "unauthorized"
              : status === 403
                ? "forbidden"
                : `client_${action}_failed`;
        const writeRefused =
          lastBusiness &&
          ([401, 403].includes(status ?? 0) ||
            ["invalid_request", "invalid_request_id", "unauthorized", "forbidden"].includes(safeCode));
        throw new ClientProofError(client, safeCode, status, action, writeRefused);
      }
    },
  };
}
