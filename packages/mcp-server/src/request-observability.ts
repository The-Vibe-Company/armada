import { AsyncLocalStorage } from "node:async_hooks";
import { redactForLog } from "./log.ts";

export const REQUEST_ID_HEADER = "x-request-id";
type Log = (line: string) => void;
const current = new AsyncLocalStorage<{ id: string; log: Log }>();
const stderr: Log = (line) => console.error(line);

export function currentRequestId(): string | undefined {
  return current.getStore()?.id;
}

/** Generate our own ID. Caller-supplied headers and runtime idempotency keys are independent. */
export function observeRequest<T extends Response | undefined>(work: () => T | Promise<T>, log: Log = stderr) {
  const id = crypto.randomUUID();
  return current.run({ id, log }, async () => {
    const started = performance.now();
    let response: T | Response;
    let errorClass: string | undefined;
    try {
      response = await work();
    } catch (error) {
      // Keep the cause's class (a code identifier), never its message: messages may carry caller data.
      errorClass = errorClassOf(error);
      response = Response.json({ error: "internal" }, { status: 500 });
    }
    log(
      JSON.stringify({
        event: "http_request",
        requestId: id,
        status: response?.status ?? 101,
        durationMs: Math.round(performance.now() - started),
        ...(errorClass ? { errorClass } : {}),
      }),
    );
    if (!response) return response;
    const headers = new Headers(response.headers);
    headers.set(REQUEST_ID_HEADER, id);
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  });
}

function errorClassOf(error: unknown): string {
  const name = error instanceof Error ? error.constructor.name : typeof error;
  return /^[A-Za-z_$][\w$]{0,63}$/.test(name) ? name : "Error";
}

export async function observeProviderCall<T>(
  provider: "boat" | "modal" | "docker",
  operation: string,
  work: () => Promise<T>,
): Promise<T> {
  const request = current.getStore();
  if (!request) return work();
  const started = performance.now();
  let outcome = "error";
  try {
    const result = await work();
    outcome = "ok";
    return result;
  } finally {
    request.log(
      JSON.stringify({
        event: "provider_call",
        requestId: request.id,
        provider,
        operation: redactForLog(operation),
        outcome,
        durationMs: Math.round(performance.now() - started),
      }),
    );
  }
}

/** Provider methods are async. Preserve the original receiver and resolve context at invocation. */
export function observeProvider<T extends object>(provider: "boat" | "modal" | "docker", adapter: T): T {
  return new Proxy(adapter, {
    get(instance, property) {
      const value = Reflect.get(instance, property, instance);
      if (typeof value !== "function" || typeof property !== "string") return value;
      return (...args: unknown[]) =>
        observeProviderCall(provider, property, () => Reflect.apply(value, instance, args));
    },
  });
}
