import {
  API_FAILURE_STATUS,
  MACHINE_SIZES,
  ORCHESTRATOR_DEFAULTS,
  ORCHESTRATOR_SKILL_PATTERN,
  type OrchestratorCreate,
  ProviderError,
} from "@armada/core";
import { apiFailureCode } from "./api-failure.ts";
import type { Caller } from "./caller.ts";
import { type OrchestratorPair, orchestratorCapabilities } from "./orchestrator-activation.ts";
import type { OrchestratorRuntime } from "./orchestrator-runtime.ts";
import { OrchestratorRuntimeError } from "./orchestrator-runtime-store.ts";

/** The same dispatcher is used by HTTP and MCP. Never accepts delegated principals. */
export async function callOrchestrator(
  service: OrchestratorRuntime | undefined,
  caller: Caller,
  action: string,
  args: Record<string, unknown>,
  key?: string,
  requestedPairs?: readonly OrchestratorPair[],
): Promise<unknown> {
  if (action === "capabilities") return orchestratorCapabilities(requestedPairs, service?.enabledPairs);
  if (!service) throw new OrchestratorRuntimeError("unavailable");
  if (typeof args.orgId !== "string") throw new OrchestratorRuntimeError("invalid_request");
  if (
    ["create", "message", "steer", "stop", "resume", "recover", "reconcile"].includes(action) &&
    (!key || !/^[ -~]{1,128}$/.test(key))
  )
    throw new OrchestratorRuntimeError("invalid_request");
  if (action === "reconcile") {
    const allowed = ["orgId", "id", "action", "expectedRevision", "text", "configuration"];
    if (
      Object.keys(args).some((key) => !allowed.includes(key)) ||
      !["create", "message", "steer", "stop", "resume"].includes(String(args.action)) ||
      (args.action === "create"
        ? !args.configuration ||
          typeof args.configuration !== "object" ||
          Array.isArray(args.configuration) ||
          (args.configuration as Record<string, unknown>).orgId !== args.orgId
        : typeof args.id !== "string" ||
          !Number.isSafeInteger(args.expectedRevision) ||
          Number(args.expectedRevision) < 0) ||
      (args.text !== undefined && typeof args.text !== "string")
    )
      throw new OrchestratorRuntimeError("invalid_request");
    return service.reconcile(caller, { ...args, key } as Parameters<OrchestratorRuntime["reconcile"]>[1]);
  }
  const fields: Record<string, string[]> = {
    list: ["orgId", "cursor", "limit"],
    detail: ["orgId", "id"],
    events: ["orgId", "id", "cursor", "limit", "direction", "maxBytes", "coalesce"],
    message: ["orgId", "id", "expectedRevision", "text"],
    steer: ["orgId", "id", "expectedRevision", "text"],
    stop: ["orgId", "id", "expectedRevision"],
    resume: ["orgId", "id", "expectedRevision"],
    recover: ["orgId", "id", "expectedRevision"],
  };
  if (action !== "create" && (!fields[action] || Object.keys(args).some((key) => !fields[action]?.includes(key))))
    throw new OrchestratorRuntimeError("invalid_request");
  if (
    (args.cursor !== undefined && typeof args.cursor !== "string") ||
    (args.limit !== undefined &&
      (!Number.isInteger(args.limit) || Number(args.limit) < 1 || Number(args.limit) > (action === "list" ? 100 : 500)))
  )
    throw new OrchestratorRuntimeError("invalid_request");
  if (action === "list")
    return service.list(caller, args.orgId, args.cursor as string | undefined, args.limit as number | undefined);
  if (action === "create") {
    const allowed = [
      "version",
      "orgId",
      "name",
      "goldenId",
      "provider",
      "harness",
      "repo",
      "skill",
      "size",
      "model",
      "reasoningEffort",
      "modelAccountId",
      "idleSeconds",
      "maxActiveChildren",
    ];
    if (
      Object.keys(args).some((key) => !allowed.includes(key)) ||
      args.version !== 1 ||
      (args.skill !== undefined &&
        (typeof args.skill !== "string" ||
          args.skill.length > 256 ||
          !ORCHESTRATOR_SKILL_PATTERN.test(args.skill) ||
          args.skill.split("/")[1]?.startsWith("armada-tools@"))) ||
      (args.size !== undefined && !(MACHINE_SIZES as readonly unknown[]).includes(args.size)) ||
      !["name", "goldenId", "model", "modelAccountId"].every(
        (key) => typeof args[key] === "string" && (args[key] as string).length > 0,
      ) ||
      ["repo", "reasoningEffort"].some(
        (key) => args[key] !== undefined && (typeof args[key] !== "string" || !(args[key] as string).trim()),
      ) ||
      (args.idleSeconds !== undefined &&
        (!Number.isInteger(args.idleSeconds) ||
          Number(args.idleSeconds) < ORCHESTRATOR_DEFAULTS.minIdleSeconds ||
          Number(args.idleSeconds) > ORCHESTRATOR_DEFAULTS.maxIdleSeconds)) ||
      (args.maxActiveChildren !== undefined &&
        (!Number.isSafeInteger(args.maxActiveChildren) || Number(args.maxActiveChildren) < 1)) ||
      !["boat", "modal"].includes(String(args.provider)) ||
      !["claude", "codex"].includes(String(args.harness))
    )
      throw new OrchestratorRuntimeError("invalid_request");
    return service.create(caller, args as unknown as OrchestratorCreate, key ?? "");
  }
  if (typeof args.id !== "string") throw new OrchestratorRuntimeError("invalid_request");
  if (action === "recover") {
    if (!Number.isSafeInteger(args.expectedRevision) || Number(args.expectedRevision) < 0)
      throw new OrchestratorRuntimeError("invalid_request");
    return service.recover(caller, {
      orgId: args.orgId,
      id: args.id,
      expectedRevision: Number(args.expectedRevision),
      key: key ?? "",
    });
  }
  if (action === "detail") return service.detail(caller, args.orgId, args.id);
  if (action === "events") {
    if (
      (args.cursor !== undefined && typeof args.cursor !== "string") ||
      (args.limit !== undefined && typeof args.limit !== "number") ||
      (args.direction !== undefined && args.direction !== "forward" && args.direction !== "backward") ||
      (args.maxBytes !== undefined && typeof args.maxBytes !== "number") ||
      (args.coalesce !== undefined && typeof args.coalesce !== "boolean")
    )
      throw new OrchestratorRuntimeError("invalid_request");
    return service.events(
      caller,
      args.orgId,
      args.id,
      args.cursor as string | undefined,
      args.limit as number | undefined,
      {
        ...(args.direction ? { direction: args.direction as "forward" | "backward" } : {}),
        ...(typeof args.maxBytes === "number" ? { maxBytes: args.maxBytes } : {}),
        ...(typeof args.coalesce === "boolean" ? { coalesce: args.coalesce } : {}),
      },
    );
  }
  if (
    !["message", "steer", "stop", "resume"].includes(action) ||
    !Number.isSafeInteger(args.expectedRevision) ||
    Number(args.expectedRevision) < 0 ||
    (args.text !== undefined && typeof args.text !== "string")
  )
    throw new OrchestratorRuntimeError("invalid_request");
  return service.mutate(caller, {
    orgId: args.orgId,
    id: args.id,
    action: action as "message" | "steer" | "stop" | "resume",
    key: key ?? "",
    expectedRevision: Number(args.expectedRevision),
    ...(typeof args.text === "string" ? { text: args.text } : {}),
  });
}

export async function orchestratorHttp(
  request: Request,
  caller: Caller,
  service?: OrchestratorRuntime,
  requestedPairs?: readonly OrchestratorPair[],
): Promise<Response> {
  const url = new URL(request.url);
  const parts = url.pathname.slice("/api/v1/orchestrators".length).split("/").filter(Boolean);
  const read = request.method === "GET";
  const action =
    parts.length === 0
      ? read
        ? "list"
        : "create"
      : parts.length === 1
        ? ["capabilities", "reconcile"].includes(parts[0] ?? "")
          ? parts[0]!
          : "detail"
        : (parts[1] ?? "");
  try {
    if (
      (read && !["list", "detail", "events", "capabilities"].includes(action)) ||
      (!read &&
        (request.method !== "POST" ||
          !["create", "message", "steer", "stop", "resume", "recover", "reconcile"].includes(action))) ||
      parts.length > 2
    )
      throw new OrchestratorRuntimeError("invalid_request");
    let args: Record<string, unknown> = {};
    if (!read) {
      const text = await request.text();
      if (text.length > 128 * 1024) throw new OrchestratorRuntimeError("invalid_request");
      const parsed: unknown = JSON.parse(text);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
        throw new OrchestratorRuntimeError("invalid_request");
      args = parsed as Record<string, unknown>;
    } else args = Object.fromEntries(url.searchParams);
    if (args.limit !== undefined) args.limit = Number(args.limit);
    if (args.maxBytes !== undefined) args.maxBytes = Number(args.maxBytes);
    if (args.coalesce !== undefined) {
      if (args.coalesce !== "true" && args.coalesce !== "false") throw new OrchestratorRuntimeError("invalid_request");
      args.coalesce = args.coalesce === "true";
    }
    if (parts[0] && !["capabilities", "reconcile"].includes(parts[0])) args.id = parts[0];
    const result = await callOrchestrator(
      service,
      caller,
      action,
      args,
      request.headers.get("idempotency-key") ?? undefined,
      requestedPairs,
    );
    return Response.json(result, { status: read ? 200 : 202, headers: { "cache-control": "no-store" } });
  } catch (error) {
    const code = orchestratorFailureCode(error);
    return Response.json(
      {
        error: {
          code,
          message: code,
          ...(error instanceof OrchestratorRuntimeError && error.admission
            ? {
                admission: error.admission,
                ...(error.operation ? { operation: error.operation } : {}),
              }
            : {}),
        },
      },
      {
        status:
          code === "not_found"
            ? 404
            : code === "conflict"
              ? 409
              : code === "invalid_request"
                ? 400
                : API_FAILURE_STATUS[code],
        headers: { "cache-control": "no-store" },
      },
    );
  }
}

export function orchestratorFailureCode(error: unknown) {
  if (error instanceof OrchestratorRuntimeError) {
    if (error.admission === "unknown") return "outcome_unknown" as const;
    return error.code === "unavailable" ? ("dependency_unavailable" as const) : error.code;
  }
  if (error instanceof SyntaxError || (error instanceof ProviderError && error.code === "invalid_request"))
    return "invalid_request" as const;
  return apiFailureCode(error) ?? "dependency_unavailable";
}
