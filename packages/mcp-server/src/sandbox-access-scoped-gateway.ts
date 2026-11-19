import { VERSION } from "@armada/core";
import { isScopedMethod, scopedOperations } from "@armada/core/contract";
import { type DelegatedAuthority, DelegatedAuthorityDenied } from "@armada/core/server";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { Route } from "./http.ts";
import { createObservedMcpTransport } from "./observed-mcp-transport.ts";
import type { createSandboxChildren } from "./sandbox-access-children.ts";
import { InvalidOrchestratorBody, readOrchestratorBody } from "./sandbox-access-http-body.ts";

/** Trusted662 bootstrap URL: never point an epoch grant at the generic owner /mcp. */
export const ORCHESTRATOR_SCOPED_PATH = "/api/v1/orchestrator-tools";
export function orchestratorScopedMcpUrl(publicUrl: string): string {
  const url = new URL(publicUrl);
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.search || url.hash)
    throw new Error("Invalid scoped gateway origin.");
  return new URL(`${ORCHESTRATOR_SCOPED_PATH}/mcp`, url).toString();
}
const restSchemas = {
  finish: scopedOperations.finish.input,
  launch: scopedOperations.launch.input.omit({ idempotencyKey: true }),
  read: scopedOperations.read.input,
  message: scopedOperations.message.input.omit({ idempotencyKey: true }),
  stop: scopedOperations.stop.input.omit({ idempotencyKey: true }),
  extend: scopedOperations.extend.input.omit({ idempotencyKey: true }),
};
const waitMethods = new Set(["wait_record", "wait_renew", "wait_complete"]);
class InvalidScopedRequest extends Error {}
class WaitAuthorityUnavailable extends Error {}
const fail = (status: number, code: string) =>
  Response.json({ error: { code, message: code } }, { status, headers: { "cache-control": "no-store" } });

export function createSandboxScopedGateway(
  children: ReturnType<typeof createSandboxChildren>,
  authority: Pick<DelegatedAuthority, "catalogGrant">,
  finish?: (token: string) => Promise<unknown>,
  runtimeFinish?: (token: string) => Promise<unknown>,
): Route {
  async function call(token: string, name: string, args: unknown): Promise<unknown> {
    if (waitMethods.has(name)) throw new WaitAuthorityUnavailable();
    if (!isScopedMethod(name) || (token.startsWith("armada_finish_") && name !== "finish"))
      throw new InvalidScopedRequest();
    const parsed = scopedOperations[name].input.safeParse(args);
    if (!parsed.success) throw new InvalidScopedRequest();
    if (name === "finish") {
      const handler = token.startsWith("armada_finish_") ? runtimeFinish : finish;
      if (!handler) throw new InvalidScopedRequest();
      return handler(token);
    }
    if (name === "launch") {
      const input = scopedOperations.launch.input.parse(args);
      const chosen = input.selection;
      return children.launch(token, input.idempotencyKey, {
        goldenId: chosen.goldenId,
        harness: chosen.harness,
        credentialId: chosen.credentialId,
        credentialVersion: chosen.credentialVersion,
        model: chosen.model,
        ...(chosen.skills === undefined ? {} : { skills: chosen.skills }),
        ...(chosen.repo === undefined ? {} : { repo: chosen.repo }),
        ...(chosen.prompt === undefined ? {} : { prompt: chosen.prompt }),
        ...(chosen.reasoningEffort === undefined ? {} : { reasoningEffort: chosen.reasoningEffort }),
        ...(chosen.size === undefined ? {} : { size: chosen.size }),
      });
    }
    if (name === "read") {
      const input = scopedOperations.read.input.parse(args);
      return children.read(token, input.sandboxId);
    }
    if (name === "message") {
      const input = scopedOperations.message.input.parse(args);
      return children.message(token, input.idempotencyKey, input.sandboxId, input.text);
    }
    if (name === "extend") {
      const input = scopedOperations.extend.input.parse(args);
      return children.extend(token, input.idempotencyKey, input.sandboxId, input.ttlSeconds);
    }
    const input = scopedOperations.stop.input.parse(args);
    return children.stop(token, input.idempotencyKey, input.sandboxId);
  }
  return async (request) => {
    const url = new URL(request.url);
    if (url.pathname !== ORCHESTRATOR_SCOPED_PATH && !url.pathname.startsWith(`${ORCHESTRATOR_SCOPED_PATH}/`))
      return null;
    const suffix = url.pathname.slice(ORCHESTRATOR_SCOPED_PATH.length + 1);
    // Owner sessions/service keys are NOT promoted into delegated authority, or vice versa.
    const match = /^Bearer (armada_epoch_[a-f0-9]{64}|armada_finish_[A-Za-z0-9_-]{1,1000}\.[A-Za-z0-9_-]{43})$/.exec(
      request.headers.get("authorization") ?? "",
    );
    if (!match?.[1]) return fail(401, "invalid_epoch_authority");
    if (request.method !== "POST") return fail(405, "use_post");
    const token = match[1];
    try {
      const raw = await readOrchestratorBody(request);
      const decoded: unknown = JSON.parse(raw);
      if (suffix !== "mcp") {
        if (waitMethods.has(suffix)) return fail(503, "admit_wait_not_supported");
        if (!isScopedMethod(suffix)) return fail(403, "scoped_method_denied");
        const input = restSchemas[suffix].safeParse(decoded);
        if (!input.success) throw new InvalidScopedRequest();
        const args =
          suffix === "read" || suffix === "finish"
            ? input.data
            : { ...input.data, idempotencyKey: request.headers.get("idempotency-key") };
        return Response.json({ result: await call(token, suffix, args) }, { headers: { "cache-control": "no-store" } });
      }
      if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) throw new InvalidScopedRequest();
      const rpc = decoded as { method?: unknown; params?: { name?: unknown; arguments?: unknown }; id?: unknown };
      if (rpc.method === "tools/call") {
        const name = rpc.params?.name;
        // Validate BEFORE SDK defaults can strip extra fields from a tool's arguments.
        if (typeof name !== "string" || (!isScopedMethod(name) && !waitMethods.has(name)))
          return fail(403, "scoped_method_denied");
        if (waitMethods.has(name)) return fail(503, "admit_wait_not_supported");
        if (!isScopedMethod(name) || !scopedOperations[name].input.safeParse(rpc.params?.arguments).success)
          throw new InvalidScopedRequest();
      }
      const server = new McpServer({ name: "armada-owned-worker-tools", version: VERSION });
      const runtime = token.startsWith("armada_finish_");
      const grant = rpc.method === "tools/list" && !runtime ? await authority.catalogGrant(token) : undefined;
      for (const name of Object.keys(scopedOperations).filter(isScopedMethod)) {
        const operation = scopedOperations[name];
        if (
          runtime
            ? name !== "finish" || !runtimeFinish
            : name === "finish" && (!finish || (grant && grant.kind !== "sandbox"))
        )
          continue;
        if (grant && !grant.scopes.includes(operation.scope)) continue;
        server.registerTool(
          name,
          {
            description: operation.description,
            inputSchema: operation.input,
            outputSchema: z.object({ result: z.unknown() }),
          },
          async (args: unknown): Promise<CallToolResult> => {
            try {
              const result = { result: await call(token, name, args) };
              return { structuredContent: result, content: [{ type: "text", text: JSON.stringify(result) }] };
            } catch (error) {
              const code =
                error instanceof DelegatedAuthorityDenied ? "scoped_authority_denied" : "scoped_operation_unavailable";
              return { isError: true, content: [{ type: "text", text: code }] };
            }
          },
        );
      }
      const transport = createObservedMcpTransport();
      await server.connect(transport);
      try {
        return await transport.handleRequest(new Request(request, { body: raw }));
      } finally {
        await server.close();
      }
    } catch (error) {
      if (error instanceof DelegatedAuthorityDenied) return fail(403, "scoped_authority_denied");
      if (error instanceof WaitAuthorityUnavailable) return fail(503, "admit_wait_not_supported");
      if (
        error instanceof InvalidScopedRequest ||
        error instanceof InvalidOrchestratorBody ||
        error instanceof SyntaxError ||
        error instanceof z.ZodError
      )
        return fail(400, "invalid_scoped_request");
      return fail(503, "scoped_operation_unavailable");
    }
  };
}
