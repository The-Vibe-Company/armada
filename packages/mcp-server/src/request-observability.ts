import { AsyncLocalStorage } from "node:async_hooks";
import { redactForLog } from "./log.ts";

export const REQUEST_ID_HEADER = "x-request-id";
type Log = (line: string) => void;
const current = new AsyncLocalStorage<{ id: string; log: Log }>();
const stderr: Log = (line) => console.error(line);

export function currentRequestId(): string | undefined {
  return current.getStore()?.id;
}

const serverId = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;

/**
 * Resume a request's correlation inside durable background work it handed off (a deferred Docker
 * launch), so provider records there carry the ID returned to the caller. Without a well-formed ID
 * the work runs uncorrelated, like other background provider work.
 */
export function continueRequest<T>(id: string | undefined, work: () => Promise<T>, log: Log = stderr): Promise<T> {
  return id && serverId.test(id) ? current.run({ id, log }, work) : work();
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

type Provider = "boat" | "modal" | "docker";

/** A call's admission slot. Admission marks every enclosing call's slot too. */
type Admission = { admitted: boolean; parent: Admission | undefined };
const admissions = new AsyncLocalStorage<Admission>();

/**
 * Durable enqueue points (Docker host jobs, runtime commands) call this when they create new
 * provider-bound work, never when they find a stored request with the same ID. A replayable call
 * uses it to tell real admission from a retry answered by Armada's database.
 */
export function noteAdmission(): void {
  for (let slot = admissions.getStore(); slot; slot = slot.parent) slot.admitted = true;
}

/**
 * One `provider_call` record per call made inside an HTTP request. `provider` may be resolved
 * late (the enrolled-runtime boundary learns it under its lock), and so may `operation`; `accepted` classifies a
 * returned value, so a refusal reply that does not throw still records `outcome: "error"`. `null` means no
 * provider was reached after all, so nothing is recorded. With `replayable`, a call that returns without
 * admitting new work (see `noteAdmission`) was a replay answered from Armada's database and records
 * nothing; a thrown failure is still recorded.
 */
export async function observeProviderCall<T>(
  provider: Provider | (() => Provider | undefined),
  operation: string | (() => string),
  work: () => Promise<T>,
  accepted: (result: T) => boolean | null = () => true,
  options: { replayable?: boolean } = {},
): Promise<T> {
  const request = current.getStore();
  if (!request) return work();
  const started = performance.now();
  const slot: Admission = { admitted: false, parent: admissions.getStore() };
  let outcome: "ok" | "error" | null = "error";
  try {
    const result = await admissions.run(slot, work);
    const verdict = options.replayable && !slot.admitted ? null : accepted(result);
    outcome = verdict === null ? null : verdict ? "ok" : "error";
    return result;
  } finally {
    if (outcome !== null) {
      const name = typeof provider === "function" ? provider() : provider;
      request.log(
        JSON.stringify({
          event: "provider_call",
          requestId: request.id,
          ...(name ? { provider: name } : {}),
          operation: redactForLog(typeof operation === "function" ? operation() : operation),
          outcome,
          durationMs: Math.round(performance.now() - started),
        }),
      );
    }
  }
}

/** Provider methods are async. Preserve the original receiver and resolve context at invocation. */
export function observeProvider<T extends object>(
  provider: Provider,
  adapter: T,
  options: { replayable?: boolean } = {},
): T {
  return new Proxy(adapter, {
    get(instance, property) {
      const value = Reflect.get(instance, property, instance);
      if (typeof value !== "function" || typeof property !== "string") return value;
      return (...args: unknown[]) =>
        observeProviderCall(provider, property, () => Reflect.apply(value, instance, args), undefined, options);
    },
  });
}
