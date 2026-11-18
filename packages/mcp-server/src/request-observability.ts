import { AsyncLocalStorage } from "node:async_hooks";
import { type FailureDiagnostic, failureDiagnostic } from "@armada/core/server";
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
 * Resume a request's correlation inside durable background work it handed off, so provider records there carry the ID returned to the caller. Without a well-formed ID
 * the work runs uncorrelated, like other background provider work.
 */
export function continueRequest<T>(id: string | undefined, work: () => Promise<T>, log: Log = stderr): Promise<T> {
  return id && serverId.test(id) ? current.run({ id, log }, work) : current.exit(work);
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
      const diagnostic = failureDiagnostic(error);
      recordOperatorDiagnostic("http.handler", diagnostic);
      errorClass = diagnostic.errorClass;
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

/** Server log sink only. Never attach diagnostics to an HTTP/tool response or sandbox event. */
export function recordOperatorFailure(
  phase: string,
  error: unknown,
  options?: { sandboxId?: string | undefined; log?: Log },
): void {
  recordOperatorDiagnostic(phase, failureDiagnostic(error), options);
}

/** Callers construct these fields from a closed vocabulary or failureDiagnostic. */
export function recordOperatorDiagnostic(
  phase: string,
  diagnostic: FailureDiagnostic,
  options: { sandboxId?: string | undefined; correlationId?: string | null; log?: Log } = {},
): void {
  const request = current.getStore();
  const log = options.log ?? request?.log ?? stderr;
  try {
    log(
      JSON.stringify({
        event: "operator_failure",
        phase: redactForLog(phase),
        requestId: options.correlationId && serverId.test(options.correlationId) ? options.correlationId : request?.id,
        sandboxId: options.sandboxId && serverId.test(options.sandboxId) ? options.sandboxId : undefined,
        ...diagnostic,
      }),
    );
  } catch {
    // A diagnostic sink failure cannot change the operation result.
  }
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
  options: { replayable?: boolean; sandboxId?: () => string | undefined } = {},
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
  } catch (error) {
    const phase = typeof operation === "function" ? operation() : operation;
    recordOperatorFailure(phase, error, { sandboxId: options.sandboxId?.() });
    throw error;
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
  options: { replayable?: boolean; sandboxId?: () => string | undefined } = {},
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
